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
import { createFlightOrderSchema } from "@/lib/validation";
import { serviceDetailRows } from "@/lib/service-summary";
import { Order } from "@/server/db/models";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { createSettings } from "@/tests/factories/settings.factory";
import { ensureMongo } from "@/tests/utils/db";

/**
 * ARRIVAL DATE AND TIME, END TO END.
 *
 * `flight.arrivalDate` existed in the schema, the model, the DTO, the detail
 * rows and the email rows — and in the create form's `defaultValues`. What it
 * did NOT have was an input. So the form submitted "" on every order, the
 * value normalised to null, and the operator had no way to enter an arrival
 * and the customer never saw one.
 *
 * These pin every layer below the form; the form itself is covered by the
 * browser QA, which is the only place a missing input can actually be caught.
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

const { sendPaymentRequestEmail } = await import("@/server/services/email.service");
const { createOrder, getOrderById, initiatePayment } = await import(
  "@/server/services/order.service"
);

const DEPART = new Date(Date.now() + 7 * 86_400_000);
/** Eight hours after departure — a plausible LHR→JFK block time. */
const ARRIVE = new Date(DEPART.getTime() + 8 * 3_600_000);

const actor = actorFor(UserRole.ADMIN);

function flightInput(overrides: Record<string, unknown> = {}) {
  return {
    serviceType: ServiceType.FLIGHT,
    bookingType: BookingType.NEW_BOOKING,
    provider: ProviderId.BUDGET,
    customer: { name: "Ada Lovelace", email: "ada@payops.test", phone: "+15555550100" },
    flight: {
      tripType: FlightTripType.ONE_WAY,
      origin: "London Heathrow",
      destination: "New York JFK",
      departureDate: DEPART.toISOString(),
      arrivalDate: ARRIVE.toISOString(),
      airline: "American Airlines",
      flightNumber: "AA101",
      pnr: "QR7X2B",
      cabinClass: "ECONOMY",
      passengers: { adults: 1, children: 0, infants: 0 },
      ...((overrides.flight as Record<string, unknown>) ?? {}),
    },
    currency: Currency.USD,
    charges: [{ name: "Airfare", amount: 120, timing: PaymentTiming.PREPAID }],
  };
}

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  await mockSession(actor);
  sentMail.length = 0;
});

describe("validation", () => {
  it("accepts an arrival date-time", () => {
    const parsed = createFlightOrderSchema.safeParse(flightInput());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.flight.arrivalDate).toBe(ARRIVE.toISOString());
    }
  });

  it("still accepts an order with no arrival (it is optional)", () => {
    const parsed = createFlightOrderSchema.safeParse(
      flightInput({ flight: { arrivalDate: "" } }),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.flight.arrivalDate).toBeNull();
  });
});

describe("persistence", () => {
  it("stores the arrival instant, time included", async () => {
    const created = await createOrder(flightInput() as never, { actor });
    const doc = await Order.findById(created.order.id).lean();
    expect(doc?.flight?.arrivalDate).toBeTruthy();
    expect(new Date(doc!.flight!.arrivalDate!).toISOString()).toBe(
      ARRIVE.toISOString(),
    );
  });

  it("rejects an arrival before departure", async () => {
    await expect(
      createOrder(
        flightInput({
          flight: {
            arrivalDate: new Date(DEPART.getTime() - 3_600_000).toISOString(),
          },
        }) as never,
        { actor },
      ),
    ).rejects.toThrow(/arrival|before the departure/i);
  });
});

describe("what the operator and customer see", () => {
  it("surfaces arrival on the DTO", async () => {
    const created = await createOrder(flightInput() as never, { actor });
    const dto = await getOrderById(created.order.id, { actor });
    expect(dto.flight?.arrivalDate).toBe(ARRIVE.toISOString());
  });

  it("renders an Arrival row next to Departure, and no car rows", async () => {
    const created = await createOrder(flightInput() as never, { actor });
    const dto = await getOrderById(created.order.id, { actor });
    const labels = serviceDetailRows(dto).map((r) => r.label);
    expect(labels).toContain("Departure");
    expect(labels).toContain("Arrival");
    expect(labels).not.toContain("Pick-up");
    expect(labels).not.toContain("Drop-off");
  });

  it("omits the Arrival row when there is no arrival", async () => {
    const created = await createOrder(
      flightInput({ flight: { arrivalDate: "" } }) as never,
      { actor },
    );
    const dto = await getOrderById(created.order.id, { actor });
    const labels = serviceDetailRows(dto).map((r) => r.label);
    expect(labels).toContain("Departure");
    expect(labels).not.toContain("Arrival");
  });

  it("shows arrival WITH ITS TIME in the payment-request email", async () => {
    const created = await createOrder(flightInput() as never, { actor });
    await initiatePayment(created.order.id, { actor });
    const dto = await getOrderById(created.order.id, { actor });
    await sendPaymentRequestEmail(dto, {}, { actor });

    const html = String(sentMail.at(-1)?.html ?? "");
    expect(html).toContain("Arrival");
    // `formatEmailDay` renders "15 Oct 2026 • 12:00 UTC" — assert the clock
    // is present, which is the specific thing reported missing.
    const hh = String(ARRIVE.getUTCHours()).padStart(2, "0");
    const mm = String(ARRIVE.getUTCMinutes()).padStart(2, "0");
    expect(html).toContain(`${hh}:${mm} UTC`);
  });
});
