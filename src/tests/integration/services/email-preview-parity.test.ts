import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  BookingType,
  Currency,
  FlightTripType,
  PaymentTiming,
  ServiceType,
  UserRole,
} from "@/lib/constants/enums";
import { ProviderId } from "@/lib/constants/providers";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { createSettings } from "@/tests/factories/settings.factory";
import { ensureMongo } from "@/tests/utils/db";
import { validCreateOrderInput } from "@/tests/fixtures/order-input.fixture";

/**
 * THE PREVIEW MUST SHOW WHAT THE SEND WILL SEND.
 *
 * `/api/orders/[id]/payment-request-preview` rendered the RENTAL template for
 * every order, so an operator previewing a flight order saw an empty
 * "Vehicle" row, blank Pick-up/Drop-off, "Total rental cost" and "Amount due
 * at counter" — then clicked Send and the customer received the flight
 * template instead. The preview was not merely ugly, it was misleading about
 * what was about to go out.
 *
 * These compare the preview route's HTML against the HTML the real send path
 * hands the transport. The two are allowed to differ only in the places a
 * preview legitimately differs; the structural markers must agree.
 */

const { sentMail } = vi.hoisted(() => ({
  sentMail: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/server/email/smtp", () => {
  const stub = {
    sendMail: async (m: Record<string, unknown>) => {
      sentMail.push(m);
      return { messageId: "<test>", response: "250 OK" };
    },
  };
  return {
    getMailer: () => stub,
    getMailerFor: () => stub,
    verifyMailer: async () => {},
    _resetOrgMailersForTests: () => {},
    applyGlobalCc: <T,>(m: T) => m,
  };
});

const { POST } = await import(
  "@/app/api/orders/[id]/payment-request-preview/route"
);
const { sendPaymentRequestEmail } = await import(
  "@/server/services/email.service"
);
const { createOrder, getOrderById, initiatePayment } = await import(
  "@/server/services/order.service"
);

const actor = actorFor(UserRole.ADMIN);

function flightInput() {
  return {
    serviceType: ServiceType.FLIGHT,
    bookingType: BookingType.NEW_BOOKING,
    provider: ProviderId.BUDGET,
    customer: {
      name: "Ada Lovelace",
      email: "ada@payops.test",
      phone: "+15555550100",
    },
    flight: {
      tripType: FlightTripType.ONE_WAY,
      origin: "London Heathrow",
      destination: "New York JFK",
      departureDate: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      airline: "British Airways",
      flightNumber: "BA178",
      pnr: "X7K2QA",
      cabinClass: "ECONOMY",
      passengers: { adults: 1, children: 0, infants: 0 },
    },
    currency: Currency.USD,
    charges: [
      { name: "Airfare", amount: 420.5, timing: PaymentTiming.PREPAID },
    ],
  };
}

async function previewAndSend(input: unknown) {
  const created = await createOrder(input as never, { actor });
  await initiatePayment(created.order.id, { actor });
  const id = created.order.id;

  const res = await POST(
    new Request(`http://localhost/api/orders/${id}/payment-request-preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }) as never,
    { params: Promise.resolve({ id }) },
  );
  const body = (await res.json()) as { data?: { html?: string } };
  const preview = body.data?.html ?? "";

  const dto = await getOrderById(id, { actor });
  await sendPaymentRequestEmail(dto, {}, { actor });
  const sentHtml = String(sentMail.at(-1)?.html ?? "");

  return { preview, sentHtml };
}

/** Structural markers that identify WHICH template rendered. */
const MARKERS = [
  "Flight details",
  "Total flight cost",
  "Vehicle",
  "Total rental cost",
  "Amount due at counter",
  "conditions of carriage",
];

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  await mockSession(actor);
  sentMail.length = 0;
});

describe("a FLIGHT order", () => {
  it("previews the flight template, matching the send", async () => {
    const { preview, sentHtml } = await previewAndSend(flightInput());
    expect(preview.length).toBeGreaterThan(0);
    for (const marker of MARKERS) {
      expect(
        preview.includes(marker),
        `preview/send disagree on "${marker}"`,
      ).toBe(sentHtml.includes(marker));
    }
  });

  it("previews flight data and no car rows", async () => {
    const { preview } = await previewAndSend(flightInput());
    expect(preview).toContain("Flight details");
    expect(preview).toContain("London Heathrow");
    expect(preview).toContain("BA178");
    expect(preview).toContain("Total flight cost");
    expect(preview).not.toContain("Vehicle");
    expect(preview).not.toContain("Total rental cost");
    expect(preview).not.toContain("Amount due at counter");
  });
});

describe("a CAR order", () => {
  it("still previews the rental template, matching the send", async () => {
    const { preview, sentHtml } = await previewAndSend(validCreateOrderInput());
    for (const marker of MARKERS) {
      expect(
        preview.includes(marker),
        `preview/send disagree on "${marker}"`,
      ).toBe(sentHtml.includes(marker));
    }
  });

  it("previews the rental structure unchanged", async () => {
    const { preview } = await previewAndSend(validCreateOrderInput());
    expect(preview).toContain("Vehicle");
    expect(preview).toContain("Total rental cost");
    expect(preview).not.toContain("Flight details");
  });
});
