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
 * WHAT A FLIGHT CUSTOMER ACTUALLY RECEIVES.
 *
 * Driven through the real send path — `sendPaymentRequestEmail` /
 * `sendPaymentConfirmationEmail` — with only the SMTP transport stubbed, so
 * template selection, branding, the T&C and policy snapshots and the logo
 * inliner are all the production ones. The assertions are on the rendered
 * HTML the stub received, which is the actual message body.
 *
 * A flight email going out shaped like a car email is the defect these
 * guard. The car assertions in the second half are equally load-bearing:
 * "the flight is right" is only half the requirement.
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

const { sendPaymentRequestEmail, sendPaymentConfirmationEmail } = await import(
  "@/server/services/email.service"
);
const { createOrder, getOrderById, initiatePayment } = await import(
  "@/server/services/order.service"
);

/** Strings that describe a car rental and nothing else. */
const CAR_ONLY = [
  "Vehicle",
  "Pick-up",
  "Drop-off",
  "Total rental cost",
  "due at counter",
  "Amount due at counter",
  "Rental provider",
  "driver&#x27;s licence",
  "driver's licence",
  "vehicle changes",
  "before pick-up",
];

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
      arrivalDate: new Date(Date.now() + 7 * 86_400_000 + 3_600_000).toISOString(),
      airline: "British Airways",
      flightNumber: "BA178",
      pnr: "X7K2QA",
      cabinClass: "ECONOMY",
      passengers: { adults: 2, children: 1, infants: 0 },
    },
    currency: Currency.USD,
    charges: [
      { name: "Airfare", amount: 420.5, timing: PaymentTiming.PREPAID },
    ],
  };
}

async function renderRequest(input: unknown) {
  const created = await createOrder(input as never, { actor });
  // The request email refuses to send without a payment link, so go through
  // the real gateway caller (stubbed transport) exactly as the UI does.
  await initiatePayment(created.order.id, { actor });
  const dto = await getOrderById(created.order.id, { actor });
  await sendPaymentRequestEmail(dto, {}, { actor });
  return String(sentMail.at(-1)?.html ?? "");
}

async function renderConfirmation(input: unknown) {
  const created = await createOrder(input as never, { actor });
  const dto = await getOrderById(created.order.id, { actor });
  await sendPaymentConfirmationEmail(dto);
  return String(sentMail.at(-1)?.html ?? "");
}

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  await mockSession(actor);
  sentMail.length = 0;
});

describe("the FLIGHT payment-request email", () => {
  it("renders the flight booking data, not a vehicle", async () => {
    const html = await renderRequest(flightInput());
    expect(html).toContain("Flight details");
    expect(html).toContain("London Heathrow");
    expect(html).toContain("New York JFK");
    expect(html).toContain("British Airways");
    expect(html).toContain("BA178");
    expect(html).toContain("X7K2QA");
    expect(html).toContain("ECONOMY");
    // 2 adults, 1 child — whatever the summariser words it as, the count is there.
    expect(html).toMatch(/2 adults/i);
  });

  it("uses the flight charge wording", async () => {
    const html = await renderRequest(flightInput());
    expect(html).toContain("Total flight cost");
    expect(html).not.toContain("Total rental cost");
  });

  it("carries the FLIGHT terms, never the rental ones", async () => {
    const html = await renderRequest(flightInput());
    expect(html).toContain("conditions of carriage");
    expect(html).toMatch(/passenger names must match/i);
  });

  it("carries the FLIGHT cancellation policy, never the rental one", async () => {
    const html = await renderRequest(flightInput());
    expect(html).toContain("Cancellation &amp; refund policy");
    expect(html).toMatch(/fare rules/i);
    expect(html).not.toMatch(/before pick-up/i);
    expect(html).not.toMatch(/vehicle changes/i);
  });

  it("is branded Airfare Fees", async () => {
    const html = await renderRequest(flightInput());
    expect(html).toContain("Airfare Fees");
  });

  it("contains NO car-only content at all", async () => {
    const html = await renderRequest(flightInput());
    for (const phrase of CAR_ONLY) {
      expect(html, `leaked car string: ${phrase}`).not.toContain(phrase);
    }
  });
});

describe("the FLIGHT payment-confirmation email", () => {
  it("renders flight data and the flight policy", async () => {
    const html = await renderConfirmation(flightInput());
    expect(html).toContain("London Heathrow");
    expect(html).toContain("BA178");
    expect(html).toMatch(/fare rules/i);
  });

  it("contains NO car-only content at all", async () => {
    const html = await renderConfirmation(flightInput());
    for (const phrase of CAR_ONLY) {
      expect(html, `leaked car string: ${phrase}`).not.toContain(phrase);
    }
  });

  it("is branded Airfare Fees", async () => {
    const html = await renderConfirmation(flightInput());
    expect(html).toContain("Airfare Fees");
  });
});

describe("the CAR emails are unchanged", () => {
  it("payment request still shows the rental structure and wording", async () => {
    const html = await renderRequest(validCreateOrderInput());
    expect(html).toContain("Vehicle");
    expect(html).toContain("Pick-up");
    expect(html).toContain("Total rental cost");
  });

  it("payment request still carries the rental T&C and policy", async () => {
    const html = await renderRequest(validCreateOrderInput());
    expect(html).toMatch(/driver(&#x27;|')s licence/);
    expect(html).toMatch(/before pick-up/i);
  });

  it("no flight branding leaks into a car email", async () => {
    const html = await renderRequest(validCreateOrderInput());
    expect(html).not.toContain("Airfare Fees");
    expect(html).not.toContain("conditions of carriage");
    expect(html).not.toContain("Flight details");
  });

  it("confirmation is likewise untouched", async () => {
    const html = await renderConfirmation(validCreateOrderInput());
    expect(html).toContain("Vehicle");
    expect(html).not.toContain("Airfare Fees");
  });
});
