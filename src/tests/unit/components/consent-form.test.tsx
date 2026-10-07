import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { ConsentForm } from "@/app/consent/[token]/consent-form";
import { FLIGHT_AMOUNT_LABELS, LEGACY_FLIGHT_AMOUNT_LABELS } from "@/lib/charges";
import {
  BookingType,
  ConsentStatus,
  Currency,
  FlightTripType,
  PaymentTiming,
  ServiceType,
} from "@/lib/constants/enums";
import { FLIGHT_PROVIDER_LABEL } from "@/lib/constants/labels";
import type {
  BrandingDTO,
  PaymentConsentFlightSnapshot,
  PaymentConsentSnapshot,
  PublicConsentView,
} from "@/types";
import { roundTripFlightInput } from "@/tests/fixtures/order-input.fixture";

/**
 * The hosted consent page — the last screen a customer reads before money
 * moves.
 *
 * Three things are pinned:
 *
 *   1. A car rental reads exactly as it always has on a Stripe brand, and a
 *      PayPal brand's customer is now told PAYPAL (the page used to say
 *      "Stripe Checkout" to everyone — the classic phishing tell).
 *   2. A flight with a frozen itinerary shows what this payment covers (the
 *      service charge) against the booking value, and every flight and
 *      layover — never "Vehicle" / "Pick-up" / "Drop-off".
 *   3. A flight frozen BEFORE itineraries existed is worded neutrally: its
 *      payment was usually the whole fare, so it is never called a service
 *      charge.
 */

const BRANDING: BrandingDTO = {
  brandName: "Rental Confirmation",
  supportEmail: "support@payops.test",
  supportPhone: "+15555550100",
  logo: "",
  primaryColor: "#0B1220",
  footerTagline: "",
  updatedAt: new Date(0).toISOString(),
};

const CONSENT_MESSAGE =
  "I confirm that I understand and agree to proceed with this payment and booking.";

function view(
  snapshot: PaymentConsentSnapshot,
  over: Partial<PublicConsentView> = {},
): PublicConsentView {
  return {
    status: ConsentStatus.REQUESTED,
    customerName: "Ada Lovelace",
    customerEmail: "ada@payops.test",
    brandName: "Rental Confirmation",
    organizationId: null,
    consentMessage: CONSENT_MESSAGE,
    snapshot,
    paymentUrl: "https://checkout.example.test/pay/1",
    gatewayLabel: "Stripe",
    // Not yet confirmed: the page renders the form, it does not redirect.
    alreadyConfirmedAt: null,
    ...over,
  };
}

const CAR_SNAPSHOT: PaymentConsentSnapshot = {
  bookingType: BookingType.NEW_BOOKING,
  provider: "Budget",
  serviceType: ServiceType.CAR_RENTAL,
  vehicle: "Toyota • Camry",
  pickupDate: "2026-10-10T15:00:00.000Z",
  dropoffDate: "2026-10-12T09:30:00.000Z",
  pickupLocation: "LAX Airport — Terminal 1",
  dropoffLocation: "San Diego Downtown",
  amount: 249.99,
  currency: Currency.USD,
  charges: [
    { name: "Rental cost", amount: 249.99, timing: PaymentTiming.PREPAID },
    { name: "Deposit", amount: 100, timing: PaymentTiming.DUE_AT_COUNTER },
  ],
  dueAtCounter: 100,
  total: 349.99,
  paymentLinkRef: "https://checkout.example.test/pay/1",
};

/** What the email service freezes for an itinerary flight. */
function itineraryFlightSnapshot(): PaymentConsentSnapshot {
  const f = roundTripFlightInput().flight;
  const flight: PaymentConsentFlightSnapshot = {
    tripType: FlightTripType.ROUND_TRIP,
    cabinClass: f.cabinClass,
    passengers: f.passengers,
    pnr: f.pnr ?? null,
    outbound: f.outbound as PaymentConsentFlightSnapshot["outbound"],
    return: f.return as PaymentConsentFlightSnapshot["return"],
    origin: null,
    destination: null,
    departureDate: null,
    arrivalDate: null,
    returnDate: null,
    airline: null,
    flightNumber: null,
  };
  return {
    bookingType: BookingType.NEW_BOOKING,
    provider: "Air India",
    serviceType: ServiceType.FLIGHT,
    vehicle: "Delhi → Varanasi → Mumbai (round trip)",
    pickupDate: "2026-10-10T10:30:00.000Z",
    dropoffDate: "2026-10-15T09:00:00.000Z",
    pickupLocation: "Delhi",
    dropoffLocation: "Mumbai",
    amount: 95,
    currency: Currency.USD,
    charges: [{ name: "Service charge", amount: 95, timing: PaymentTiming.PREPAID }],
    dueAtCounter: 0,
    total: 95,
    flight,
    airlineFare: 1240,
    bookingTotal: 1335,
    paymentLinkRef: "https://checkout.example.test/pay/1",
  };
}

/** What was frozen for a flight created BEFORE itineraries: flat fields
 *  only, its whole fare as the prepaid "Airfare" line. */
function legacyFlightSnapshot(): PaymentConsentSnapshot {
  return {
    bookingType: BookingType.NEW_BOOKING,
    provider: "Budget",
    serviceType: ServiceType.FLIGHT,
    vehicle: "Test Airways TA123 • LHR → JFK",
    pickupDate: "2026-11-01T09:15:00.000Z",
    dropoffDate: "2026-11-01T09:15:00.000Z",
    pickupLocation: "LHR",
    dropoffLocation: "JFK",
    amount: 420.5,
    currency: Currency.USD,
    charges: [{ name: "Airfare", amount: 420.5, timing: PaymentTiming.PREPAID }],
    dueAtCounter: 0,
    total: 420.5,
    flight: {
      tripType: FlightTripType.ONE_WAY,
      cabinClass: "ECONOMY",
      passengers: { adults: 1, children: 0, infants: 0 },
      pnr: null,
      outbound: null,
      return: null,
      origin: "LHR",
      destination: "JFK",
      departureDate: "2026-11-01T09:15:00.000Z",
      arrivalDate: "2026-11-01T17:40:00.000Z",
      returnDate: null,
      airline: "Test Airways",
      flightNumber: "TA123",
    },
    airlineFare: 0,
    bookingTotal: 420.5,
    paymentLinkRef: "https://checkout.example.test/pay/1",
  };
}

/** The page's visible text, whitespace collapsed. */
function pageText(v: PublicConsentView, branding: BrandingDTO = BRANDING): string {
  const { container } = render(
    <ConsentForm token="test-token" initialView={v} branding={branding} />,
  );
  return (container.textContent ?? "").replace(/\s+/g, " ");
}

const CAR_WORDS = ["Vehicle", "Pick-up", "Drop-off", "rental", "counter"];

describe("a car rental's consent page", () => {
  it("reads exactly as before on a Stripe brand", () => {
    const text = pageText(view(CAR_SNAPSHOT));
    expect(text).toContain(
      "Review the details below, sign with your full name, and you'll continue to Rental Confirmation's secure Stripe checkout.",
    );
    expect(text).toContain(
      "You'll be taken directly to Stripe Checkout to complete payment. Your timestamp and IP are recorded against this booking as evidence of consent.",
    );
    expect(text).toContain("Email support@payops.test if you need help.");
    for (const label of [
      "You are paying today",
      "Paid online today",
      "Remaining balance due at rental counter",
      "Total rental cost",
      "Provider",
      "Vehicle",
      "Pick-up",
      "Drop-off",
    ]) {
      expect(text).toContain(label);
    }
    expect(text).toContain("Toyota • Camry");
  });

  it("names PayPal on a PayPal brand — never Stripe", () => {
    const text = pageText(view(CAR_SNAPSHOT, { gatewayLabel: "PayPal" }));
    expect(text).toContain("continue to Rental Confirmation's secure PayPal checkout.");
    expect(text).toContain("You'll be taken directly to PayPal Checkout to complete payment.");
    expect(text).not.toContain("Stripe");
    // The rest of the car page is untouched.
    expect(text).toContain("Total rental cost");
  });

  it("names no processor at all when the record has none", () => {
    const text = pageText(view(CAR_SNAPSHOT, { gatewayLabel: null }));
    expect(text).toContain("continue to Rental Confirmation's secure checkout.");
    expect(text).toContain("You'll be taken directly to our secure checkout to complete payment.");
    expect(text).not.toContain("Stripe");
    expect(text).not.toContain("PayPal");
  });

  it("offers no dead support link to a brand that publishes no address", () => {
    const { container } = render(
      <ConsentForm
        token="test-token"
        initialView={view(CAR_SNAPSHOT)}
        branding={{ ...BRANDING, supportEmail: "" }}
      />,
    );
    expect(container.querySelector('a[href^="mailto:"]')).toBeNull();
  });
});

describe("a flight's consent page, frozen with its itinerary", () => {
  it("shows the service charge against the booking value, with the client's labels", () => {
    const text = pageText(
      view(itineraryFlightSnapshot(), { brandName: "FlightBizz", gatewayLabel: "Stripe" }),
    );
    expect(text).toContain(FLIGHT_AMOUNT_LABELS.payableNow);
    expect(text).toContain(FLIGHT_AMOUNT_LABELS.serviceCharge);
    expect(text).toContain(FLIGHT_AMOUNT_LABELS.airlineFare);
    expect(text).toContain(FLIGHT_AMOUNT_LABELS.airlineFareNote);
    expect(text).toContain(FLIGHT_AMOUNT_LABELS.bookingTotal);
    expect(text).toContain("$95.00");
    expect(text).toContain("$1,240.00");
    expect(text).toContain("$1,335.00");
  });

  it("lists the four rows in order, then says the airline charge is not collected", () => {
    const { container } = render(
      <ConsentForm
        token="test-token"
        initialView={view(itineraryFlightSnapshot())}
        branding={BRANDING}
      />,
    );
    const text = (container.textContent ?? "").replace(/\s+/g, " ");
    // The breakdown box, after the "Amount Payable Now" hero.
    const box = text.slice(text.indexOf(FLIGHT_AMOUNT_LABELS.airlineFare));
    expect(box).toContain(
      `${FLIGHT_AMOUNT_LABELS.airlineFare}${FLIGHT_AMOUNT_LABELS.airlineFareNote}$1,240.00` +
        `${FLIGHT_AMOUNT_LABELS.serviceCharge}$95.00` +
        `${FLIGHT_AMOUNT_LABELS.bookingTotal}$1,335.00` +
        `${FLIGHT_AMOUNT_LABELS.payableNow}$95.00` +
        FLIGHT_AMOUNT_LABELS.airlineFareExplainer,
    );
  });

  it("leaves the airline row and its explainer out when there is no airline charge", () => {
    const text = pageText(
      view({ ...itineraryFlightSnapshot(), airlineFare: 0, bookingTotal: 95 }),
    );
    expect(text).not.toContain(FLIGHT_AMOUNT_LABELS.airlineFare);
    expect(text).not.toContain(FLIGHT_AMOUNT_LABELS.airlineFareExplainer);
    expect(text).toContain(`${FLIGHT_AMOUNT_LABELS.bookingTotal}$95.00`);
    expect(text).toContain(`${FLIGHT_AMOUNT_LABELS.payableNow}$95.00`);
    expect(text).not.toContain("$0.00");
  });

  it("calls the provider the airline or supplier and lists the trip-level rows", () => {
    const text = pageText(view(itineraryFlightSnapshot()));
    expect(text).toContain(FLIGHT_PROVIDER_LABEL);
    expect(text).toContain("Round trip");
    expect(text).toContain("Business");
    expect(text).toContain("2 adults, 1 child");
    expect(text).toContain("ABC123");
  });

  it("shows every flight and every layover, in both directions", () => {
    const text = pageText(view(itineraryFlightSnapshot()));
    expect(text).toContain("Itinerary");
    for (const route of [
      "Delhi → Varanasi",
      "Varanasi → Mumbai",
      "Mumbai → Varanasi",
      "Varanasi → Delhi",
    ]) {
      expect(text).toContain(route);
    }
    expect(text).toContain("Layover: 2h 30m — Varanasi");
    expect(text).toContain("Layover: 2h — Varanasi");
    expect(text).toContain("Change terminals");
    expect(text).toContain("Sat, Oct 10, 2026");
    expect(text).toContain("10:30 AM → 12:00 PM");
  });

  it("uses no rental vocabulary", () => {
    const text = pageText(view(itineraryFlightSnapshot()));
    for (const word of CAR_WORDS) {
      expect(text).not.toContain(word);
    }
    expect(text).not.toContain("You are paying today");
  });
});

describe("a MODIFICATION of an itinerary flight", () => {
  it("is worded neutrally — the payment is not a service charge", () => {
    const snapshot: PaymentConsentSnapshot = {
      ...itineraryFlightSnapshot(),
      bookingType: BookingType.MODIFICATION,
      charges: [{ name: "Change fee", amount: 95, timing: PaymentTiming.PREPAID }],
    };
    const text = pageText(view(snapshot));
    expect(text).toContain(LEGACY_FLIGHT_AMOUNT_LABELS.payableNow);
    expect(text).toContain(LEGACY_FLIGHT_AMOUNT_LABELS.serviceCharge); // "Charged online"
    expect(text.toLowerCase()).not.toContain("service charge");
    // The itinerary is still shown in full.
    expect(text).toContain("Layover: 2h 30m — Varanasi");
  });
});

describe("a flight frozen BEFORE itineraries existed", () => {
  it("is worded neutrally — never a 'service charge', never 'not part of this payment'", () => {
    const text = pageText(view(legacyFlightSnapshot()));
    expect(text).toContain(LEGACY_FLIGHT_AMOUNT_LABELS.payableNow);
    expect(text).toContain(LEGACY_FLIGHT_AMOUNT_LABELS.serviceCharge); // "Charged online"
    expect(text).toContain(LEGACY_FLIGHT_AMOUNT_LABELS.bookingTotal);
    expect(text.toLowerCase()).not.toContain("service charge");
    expect(text).not.toContain(FLIGHT_AMOUNT_LABELS.airlineFareNote);
    expect(text).not.toContain(FLIGHT_AMOUNT_LABELS.airlineFare);
    // Its single flat flight still renders, through the same itinerary view.
    expect(text).toContain("LHR → JFK");
    expect(text).toContain(FLIGHT_PROVIDER_LABEL);
    for (const word of CAR_WORDS) {
      expect(text).not.toContain(word);
    }
  });

  it("keeps the folded summary for a record that predates the frozen flight", () => {
    // A consent record written before `snapshot.flight` existed at all.
    const older: PaymentConsentSnapshot = legacyFlightSnapshot();
    delete older.flight;
    delete older.airlineFare;
    delete older.bookingTotal;
    const text = pageText(view(older));
    expect(text).toContain(FLIGHT_PROVIDER_LABEL);
    expect(text).toContain("Route");
    expect(text).toContain("Departure");
    expect(text).toContain("Test Airways TA123 • LHR → JFK");
    // A one-way stores its departure in both slots; no fake "Return" row.
    expect(text).not.toContain("Return");
    expect(text.toLowerCase()).not.toContain("service charge");
    for (const word of CAR_WORDS) {
      expect(text).not.toContain(word);
    }
  });
});
