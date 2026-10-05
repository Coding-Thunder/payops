import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  BookingType,
  ConsentMode,
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
 * THE PRE-PAYMENT SUMMARY THE CUSTOMER CONFIRMS.
 *
 * The hosted consent page is the last thing a customer reads before being
 * handed to Stripe or PayPal. It was rendering the consent snapshot, which is
 * car-shaped evidence: a flight's route went into the "vehicle" slot, its
 * departure into "pickup", and its "dropoff" fell back to the DEPARTURE date
 * for a one-way — so the page showed a Return identical to the Departure, and
 * no arrival at all.
 *
 * `serviceRows` now carries the order's own itinerary. The persisted snapshot
 * is untouched, because it is append-only evidence.
 */

vi.mock("@/server/email/smtp", () => {
  const stub = {
    sendMail: async () => ({ messageId: "<test>", response: "250 OK" }),
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
const { getPublicConsentView } = await import("@/server/services/consent.service");
const { createOrder, getOrderById, initiatePayment } = await import(
  "@/server/services/order.service"
);

const DEPART = new Date(Date.now() + 7 * 86_400_000);
const ARRIVE = new Date(DEPART.getTime() + 8 * 3_600_000);
const actor = actorFor(UserRole.ADMIN);
const BRAND = { brandName: "Rental Travels", supportEmail: "s@x.test", supportPhone: "+1" };

function flightInput() {
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
    },
    currency: Currency.USD,
    charges: [{ name: "Airfare", amount: 120, timing: PaymentTiming.PREPAID }],
  };
}

/** Create an order, generate its link, send the request — which mints the
 *  consent — and return the public view the hosted page renders. */
async function consentViewFor(input: unknown) {
  const created = await createOrder(input as never, { actor });
  await initiatePayment(created.order.id, { actor });
  const dto = await getOrderById(created.order.id, { actor });
  const { consentToken } = await sendPaymentRequestEmail(dto, {}, { actor });
  expect(consentToken).toBeTruthy();
  return getPublicConsentView(consentToken!, BRAND);
}

beforeEach(async () => {
  await ensureMongo();
  // Consent must actually be requested for a token to exist.
  await createSettings({ consentMode: ConsentMode.REQUIRED });
  await mockSession(actor);
});

describe("a FLIGHT consent page", () => {
  it("carries the flight itinerary, arrival included", async () => {
    const view = await consentViewFor(flightInput());
    const byLabel = new Map(view.serviceRows.map((r) => [r.label, r.value]));

    expect(byLabel.get("Route")).toBe("London Heathrow → New York JFK");
    expect(byLabel.get("Airline")).toBe("American Airlines AA101");
    expect(byLabel.get("PNR")).toBe("QR7X2B");
    expect(byLabel.has("Departure")).toBe(true);
    expect(byLabel.has("Arrival")).toBe(true);
    expect(byLabel.get("Cabin")).toBe("ECONOMY");
  });

  it("shows the arrival WITH its time", async () => {
    const view = await consentViewFor(flightInput());
    const arrival = view.serviceRows.find((r) => r.label === "Arrival")!.value;
    const hh = String(ARRIVE.getUTCHours()).padStart(2, "0");
    const mm = String(ARRIVE.getUTCMinutes()).padStart(2, "0");
    expect(arrival).toContain(`${hh}:${mm} UTC`);
  });

  it("does NOT present a Return for a one-way flight", async () => {
    // The old page derived Return from the snapshot's dropoff slot, which
    // fell back to the departure date — a Return that did not exist.
    const view = await consentViewFor(flightInput());
    const labels = view.serviceRows.map((r) => r.label);
    expect(labels).not.toContain("Return");
    expect(labels).toContain("Trip type");
  });

  it("shows no car rows", async () => {
    const view = await consentViewFor(flightInput());
    const labels = view.serviceRows.map((r) => r.label);
    for (const l of ["Vehicle", "Pick-up", "Drop-off"]) {
      expect(labels).not.toContain(l);
    }
  });

  it("agrees with the order on amount and currency", async () => {
    const view = await consentViewFor(flightInput());
    expect(view.snapshot.amount).toBe(120);
    expect(view.snapshot.currency).toBe("USD");
  });
});

describe("a CAR consent page", () => {
  it("still carries the rental rows", async () => {
    const view = await consentViewFor(validCreateOrderInput());
    const labels = view.serviceRows.map((r) => r.label);
    expect(labels).toContain("Vehicle");
    expect(labels).toContain("Pick-up");
    expect(labels).toContain("Drop-off");
    expect(labels).not.toContain("Route");
  });

  it("keeps its snapshot fields intact for the evidence chain", async () => {
    const view = await consentViewFor(validCreateOrderInput());
    expect(view.snapshot.vehicle).toBeTruthy();
    expect(view.snapshot.pickupDate).toBeTruthy();
    expect(view.snapshot.dropoffDate).toBeTruthy();
  });
});
