import { describe, expect, it } from "vitest";
import { render, within } from "@testing-library/react";

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
import { formatDateTime } from "@/lib/format";
import { serviceDetailRows } from "@/lib/service-summary";
import type {
  BrandingDTO,
  PaymentConsentFlightSnapshot,
  PaymentConsentHotelSnapshot,
  PaymentConsentSnapshot,
  PublicConsentView,
} from "@/types";
import { roundTripFlightInput } from "@/tests/fixtures/order-input.fixture";

/**
 * The hosted consent page — the last screen a customer reads before money
 * moves.
 *
 * Four things are pinned:
 *
 *   1. A car rental reads exactly as it always has on a Stripe brand, and a
 *      PayPal brand's customer is now told PAYPAL (the page used to say
 *      "Stripe Checkout" to everyone — the classic phishing tell). None of
 *      the flight's money wording — its Airline Charge above all — reaches
 *      a car, and its button still reads "Confirm & Continue to Payment".
 *   2. A flight with a frozen itinerary shows what this payment covers —
 *      its ONE charge, under the name the operator gave it (Rental Cost,
 *      Processing Fee, Agency Fee…; "Service Charge" when left as is) —
 *      against the booking value, and every flight and layover — never
 *      "Vehicle" / "Pick-up" / "Drop-off".
 *   3. A MODIFICATION's charge row carries the operator's name too, but no
 *      sentence presents it as the booking's charge; one whose charge was
 *      never named (stored before naming existed) stays neutral.
 *   4. A flight frozen BEFORE itineraries existed is worded neutrally: its
 *      payment was usually the whole fare, so it is never called a service
 *      charge.
 *
 * And the submit button: a flight whose charge has a name says what the
 * customer is about to pay ("Confirm & pay $100.00 Rental Cost"); every car,
 * every hotel and a flight with no named charge keeps "Confirm & Continue
 * to Payment". A hotel frozen with its stay shows it from the shared rows,
 * under "Total hotel cost"; one frozen before stays were keeps its folded
 * rows.
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

/** What the email service freezes for an itinerary flight. Its one line
 *  still carries the name every flight line was stored under before
 *  operators named the charge ("Service charge"), which reads as the
 *  default, "Service Charge". */
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

/** A NEW BOOKING of the itinerary flight whose one charge line is stored as
 *  `chargeName`: airline charge 400, the charge 100 — booking value 500. */
function flightWithCharge(chargeName: string): PaymentConsentSnapshot {
  return {
    ...itineraryFlightSnapshot(),
    amount: 100,
    charges: [{ name: chargeName, amount: 100, timing: PaymentTiming.PREPAID }],
    total: 100,
    airlineFare: 400,
    bookingTotal: 500,
  };
}

/** The breakdown box the customer reads, rows in order, for
 *  `flightWithCharge` — the charge row labelled `label`. */
function breakdownWithCharge(label: string): string {
  return (
    "Airline ChargeNot collected through this payment link$400.00" +
    `${label}$100.00` +
    "Total Booking Value$500.00" +
    "Amount Payable Now$100.00" +
    "Airline Charge is shown for the total booking value and is not collected through this payment link."
  );
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

  it("shows none of the flight's money wording — no Airline Charge — and its own rows as always", () => {
    const text = pageText(view(CAR_SNAPSHOT));
    for (const flightWording of [
      FLIGHT_AMOUNT_LABELS.airlineFare,
      FLIGHT_AMOUNT_LABELS.airlineFareNote,
      FLIGHT_AMOUNT_LABELS.bookingTotal,
      FLIGHT_AMOUNT_LABELS.payableNow,
      FLIGHT_AMOUNT_LABELS.serviceCharge,
      LEGACY_FLIGHT_AMOUNT_LABELS.serviceCharge,
    ]) {
      expect(text).not.toContain(flightWording);
    }
    expect(text).toContain("You are paying today$249.99");
    expect(text).toContain("Paid online today$249.99");
    expect(text).toContain("Remaining balance due at rental counter$100.00");
    expect(text).toContain("Total rental cost$349.99");
  });

  it.each(["Stripe", "PayPal", null])(
    "submits with 'Confirm & Continue to Payment' whatever the processor (%s)",
    (gatewayLabel) => {
      const { container } = render(
        <ConsentForm
          token="test-token"
          initialView={view(CAR_SNAPSHOT, { gatewayLabel })}
          branding={BRANDING}
        />,
      );
      const submit = within(container).getByRole("button", {
        name: "Confirm & Continue to Payment",
      });
      expect(submit).toHaveAttribute("type", "submit");
      expect(submit.textContent).toBe("Confirm & Continue to Payment");
    },
  );
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

describe("a flight's consent page names the charge as the operator did", () => {
  it.each(["Rental Cost", "Processing Fee", "Agency Fee"])(
    "a charge named %s is what the customer sees — never 'Service Charge'",
    (name) => {
      const text = pageText(view(flightWithCharge(name)));
      // Under the amount payable now…
      expect(text).toContain(`Amount Payable Now$100.00${name}New booking`);
      // …and as its own row: the airline charge under its fixed label, then
      // the operator's charge under its name, then the totals.
      expect(text).toContain(breakdownWithCharge(name));
      expect(text.toLowerCase()).not.toContain("service charge");
      expect(text).not.toContain(LEGACY_FLIGHT_AMOUNT_LABELS.serviceCharge);
    },
  );

  it.each([
    ["stored under the default name", "Service Charge"],
    ["stored before operators named it", "Service charge"],
  ])("a charge %s reads 'Service Charge'", (_case, stored) => {
    const text = pageText(view(flightWithCharge(stored)));
    expect(text).toContain("Amount Payable Now$100.00Service ChargeNew booking");
    expect(text).toContain(breakdownWithCharge("Service Charge"));
    expect(text).not.toContain(LEGACY_FLIGHT_AMOUNT_LABELS.serviceCharge);
    // The pre-naming spelling itself never reaches the customer.
    expect(text).not.toContain("Service charge");
  });
});

describe("a MODIFICATION of an itinerary flight", () => {
  it("labels its charge with the operator's name — never 'Service Charge' — and keeps the sentences neutral", () => {
    const snapshot: PaymentConsentSnapshot = {
      ...itineraryFlightSnapshot(),
      bookingType: BookingType.MODIFICATION,
      charges: [{ name: "Change fee", amount: 95, timing: PaymentTiming.PREPAID }],
    };
    const text = pageText(view(snapshot));
    expect(text).toContain(LEGACY_FLIGHT_AMOUNT_LABELS.payableNow);
    // The operator named the charge, so that name labels its row.
    expect(text).toContain(`${FLIGHT_AMOUNT_LABELS.airlineFareNote}$1,240.00Change fee$95.00`);
    expect(text).not.toContain(LEGACY_FLIGHT_AMOUNT_LABELS.serviceCharge); // "Charged Online"
    expect(text.toLowerCase()).not.toContain("service charge");
    // No sentence presents it as the booking's charge: nothing under the
    // amount payable now, so the name is shown on its row — and on the
    // button that pays it, like every named flight charge.
    expect(text).toContain(`${FLIGHT_AMOUNT_LABELS.payableNow}$95.00Modification`);
    expect(text.split("Change fee")).toHaveLength(3);
    expect(text).toContain("Confirm & pay $95.00 Change fee");
    // The itinerary is still shown in full.
    expect(text).toContain("Layover: 2h 30m — Varanasi");
  });

  it("stays neutral — 'Charged Online' — when its charge was never named", () => {
    // Stored before operators named the charge, when every flight line was
    // called exactly "Service charge" whatever its booking type.
    const snapshot: PaymentConsentSnapshot = {
      ...itineraryFlightSnapshot(),
      bookingType: BookingType.MODIFICATION,
      charges: [{ name: "Service charge", amount: 95, timing: PaymentTiming.PREPAID }],
    };
    const text = pageText(view(snapshot));
    expect(text).toContain(LEGACY_FLIGHT_AMOUNT_LABELS.payableNow);
    expect(text).toContain(
      `${FLIGHT_AMOUNT_LABELS.airlineFareNote}$1,240.00${LEGACY_FLIGHT_AMOUNT_LABELS.serviceCharge}$95.00`,
    );
    expect(text).toContain(`${FLIGHT_AMOUNT_LABELS.payableNow}$95.00Modification`);
    expect(text.toLowerCase()).not.toContain("service charge");
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

/** The submit button, by its accessible name. */
function submitButton(v: PublicConsentView, name: string): HTMLElement {
  const { container } = render(
    <ConsentForm token="test-token" initialView={v} branding={BRANDING} />,
  );
  const button = within(container).getByRole("button", { name });
  expect(button).toHaveAttribute("type", "submit");
  return button;
}

describe("the submit button names a flight's charge — and only a flight's", () => {
  it.each(["Rental Cost", "Processing Fee"])(
    "a flight whose charge is named %s: 'Confirm & pay $100.00 %s'",
    (name) => {
      const button = submitButton(view(flightWithCharge(name)), `Confirm & pay $100.00 ${name}`);
      expect(button.textContent).toBe(`Confirm & pay $100.00 ${name}`);
    },
  );

  it("a new booking still under the pre-naming 'Service charge' pays its default name", () => {
    submitButton(view(itineraryFlightSnapshot()), "Confirm & pay $95.00 Service Charge");
  });

  it.each([
    [
      "a modification whose charge was never named",
      {
        ...itineraryFlightSnapshot(),
        bookingType: BookingType.MODIFICATION,
        charges: [{ name: "Service charge", amount: 95, timing: PaymentTiming.PREPAID }],
      } as PaymentConsentSnapshot,
    ],
    ["a flight frozen before itineraries", legacyFlightSnapshot()],
  ])("%s keeps 'Confirm & Continue to Payment'", (_case, snapshot) => {
    submitButton(view(snapshot), "Confirm & Continue to Payment");
  });
});

/* ------------------------------------------------------------------ *
 * A hotel
 * ------------------------------------------------------------------ */

/** What was frozen for a hotel REQUEST before stays were: the folded item
 *  and dates only. Prepaid room, balance at the property. */
function hotelSnapshot(): PaymentConsentSnapshot {
  return {
    bookingType: BookingType.NEW_BOOKING,
    provider: "Harbour Stays",
    serviceType: ServiceType.HOTEL,
    vehicle: "Harbour View Hotel • Lisbon, Portugal",
    pickupDate: "2026-11-16T00:00:00.000Z",
    dropoffDate: "2026-11-19T00:00:00.000Z",
    pickupLocation: "Lisbon, Portugal",
    dropoffLocation: "Lisbon, Portugal",
    amount: 300,
    currency: Currency.USD,
    charges: [
      { name: "Room charge", amount: 300, timing: PaymentTiming.PREPAID },
      { name: "Resort fee", amount: 50, timing: PaymentTiming.DUE_AT_COUNTER },
    ],
    dueAtCounter: 50,
    total: 350,
    paymentLinkRef: "https://checkout.example.test/pay/1",
  };
}

const STAY: PaymentConsentHotelSnapshot = {
  destination: "Lisbon, Portugal",
  propertyName: "Harbour View Hotel",
  checkInDate: "2026-11-16T00:00:00.000Z",
  checkOutDate: "2026-11-19T00:00:00.000Z",
  rooms: 1,
  guests: { adults: 2, children: 1 },
  roomPreference: "King bed, high floor",
};

describe("a hotel's consent page", () => {
  it("totals the stay as 'Total hotel cost' — the one hotel total label — beside its balance at the property", () => {
    const text = pageText(view(hotelSnapshot()));
    expect(text).toContain(
      "Paid online today$300.00Remaining balance due at the property$50.00Total hotel cost$350.00",
    );
    expect(text).not.toContain("Total stay cost");
    expect(text).not.toContain("counter");
  });

  it("shows a frozen stay from the shared rows — property, destination, calendar days, rooms, guests, room preference", () => {
    const text = pageText(view({ ...hotelSnapshot(), hotel: STAY }));
    const rows = serviceDetailRows({ serviceType: ServiceType.HOTEL, hotel: STAY });
    expect(rows.map((r) => r.label)).toEqual([
      "Property",
      "Destination",
      "Check-in",
      "Check-out",
      "Rooms",
      "Guests",
      "Room preference",
    ]);
    expect(text).toContain(
      `Hotel / SupplierHarbour Stays${rows.map((r) => `${r.label}${r.value}`).join("")}`,
    );
    expect(text).toContain("Room preferenceKing bed, high floor");
    expect(text).toContain("Guests2 adults, 1 child");
    // Calendar days: no clock time, and not the folded item.
    expect(text).not.toMatch(/\d{1,2}:\d{2}\s?(AM|PM)/);
    expect(text).not.toContain("Harbour View Hotel • Lisbon, Portugal");
    submitButton(view({ ...hotelSnapshot(), hotel: STAY }), "Confirm & Continue to Payment");
  });

  it("keeps the folded rows for a record frozen before stays were", () => {
    const snapshot = hotelSnapshot();
    const text = pageText(view(snapshot));
    expect(text).toContain(
      `Hotel / SupplierHarbour StaysPropertyHarbour View Hotel • Lisbon, PortugalCheck-in${formatDateTime(snapshot.pickupDate)} · Lisbon, PortugalCheck-out${formatDateTime(snapshot.dropoffDate)} · Lisbon, Portugal`,
    );
    expect(text).not.toContain("Destination");
    expect(text).not.toContain("Room preference");
  });
});
