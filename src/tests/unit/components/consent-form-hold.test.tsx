import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";

import { ConsentForm } from "@/app/consent/[token]/consent-form";
import {
  BookingType,
  ConsentStatus,
  Currency,
  FlightTripType,
  PaymentTiming,
  ServiceType,
} from "@/lib/constants/enums";
import type {
  BrandingDTO,
  PaymentConsentFlightSnapshot,
  PaymentConsentHotelSnapshot,
  PaymentConsentSnapshot,
  PublicConsentView,
} from "@/types";
import { roundTripFlightInput } from "@/tests/fixtures/order-input.fixture";
import { renderWithUser } from "@/tests/utils/render";

/**
 * The hosted consent page for a MANUAL-capture order: the checkout the
 * customer is about to open only places a HOLD on the card, and an operator
 * captures it later. The page gets that from `view.authorizationHold`
 * (present and true only for such an order), and every sentence that would
 * claim money is taken today has to say "hold" instead:
 *
 *   1. Car and hotel: the summary's amount and its breakdown row read
 *      "Card hold today" (not "You are paying today" / "Paid online today").
 *      The button reads "Confirm & Authorize Card" and the footnote says the
 *      checkout places a hold, not a charge.
 *   2. Flight: the charge is "<name> On Hold" (not "Amount Payable Now"), in
 *      the summary and as the breakdown's last row, and the button reads
 *      "Confirm & authorize $100.00 <name>". A flight frozen before
 *      itineraries reads "Amount On Hold" and "Confirm & Authorize Card".
 *   3. The redirect screen, both after the customer signs and when they come
 *      back to a link they already signed: the checkout will "authorize your
 *      card — you won't be charged yet". After signing it is worded from the
 *      view the server returns, which describes the link it redirects to, so
 *      a link regenerated while the page was open is described correctly.
 *
 * Without the flag (every automatic order) the page must read exactly as
 * before, so each hold case is paired with its automatic counterpart. The
 * automatic page's full wording is pinned in consent-form.test.tsx.
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

const PAYMENT_URL = "https://checkout.example.test/pay/1";

/** What getPublicConsentView adds for a manual-capture order. */
const HOLD = { authorizationHold: true } as const;

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
    paymentUrl: PAYMENT_URL,
    gatewayLabel: "Stripe",
    // Not yet confirmed: the page renders the form, it does not redirect.
    alreadyConfirmedAt: null,
    ...over,
  };
}

/** The same view after the customer has signed, as the server returns it. */
function signed(v: PublicConsentView): PublicConsentView {
  return { ...v, status: ConsentStatus.VERIFIED, alreadyConfirmedAt: "2026-10-16T09:00:00.000Z" };
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
  paymentLinkRef: PAYMENT_URL,
};

/** A hotel request: prepaid room, resort fee at the property. */
const HOTEL_SNAPSHOT: PaymentConsentSnapshot = {
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
  paymentLinkRef: PAYMENT_URL,
};

const STAY: PaymentConsentHotelSnapshot = {
  destination: "Lisbon, Portugal",
  propertyName: "Harbour View Hotel",
  checkInDate: "2026-11-16T00:00:00.000Z",
  checkOutDate: "2026-11-19T00:00:00.000Z",
  rooms: 1,
  guests: { adults: 2, children: 1 },
  roomPreference: "King bed, high floor",
};

/** A NEW BOOKING of an itinerary flight whose one charge line is stored as
 *  `chargeName`: airline charge 400, the charge 100, booking value 500. */
function flightWithCharge(chargeName: string): PaymentConsentSnapshot {
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
    amount: 100,
    currency: Currency.USD,
    charges: [{ name: chargeName, amount: 100, timing: PaymentTiming.PREPAID }],
    dueAtCounter: 0,
    total: 100,
    flight,
    airlineFare: 400,
    bookingTotal: 500,
    paymentLinkRef: PAYMENT_URL,
  };
}

/** A flight frozen BEFORE itineraries: flat fields only, its whole fare as
 *  the prepaid "Airfare" line. */
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
    paymentLinkRef: PAYMENT_URL,
  };
}

/** The page's visible text, whitespace collapsed. */
function pageText(v: PublicConsentView): string {
  const { container } = render(
    <ConsentForm token="test-token" initialView={v} branding={BRANDING} />,
  );
  return (container.textContent ?? "").replace(/\s+/g, " ");
}

/** The submit button, by its accessible name, with its exact text. */
function submitButton(v: PublicConsentView, name: string): HTMLElement {
  const { container } = render(
    <ConsentForm token="test-token" initialView={v} branding={BRANDING} />,
  );
  const button = within(container).getByRole("button", { name });
  expect(button).toHaveAttribute("type", "submit");
  expect(button.textContent).toBe(name);
  return button;
}

const HOLD_FOOTNOTE =
  "You'll be taken directly to Stripe Checkout to authorize your card. This places a hold, not a charge — the amount is collected only once your booking is confirmed. Your timestamp and IP are recorded against this booking as evidence of consent. Email support@payops.test if you need help.";

const PAY_FOOTNOTE =
  "You'll be taken directly to Stripe Checkout to complete payment. Your timestamp and IP are recorded against this booking as evidence of consent. Email support@payops.test if you need help.";

/** Every pay-now phrase a car or hotel page used before holds existed. */
const PAY_NOW_WORDS = /You are paying today|Paid online today|Continue to Payment|complete payment/;

/* ------------------------------------------------------------------ *
 * Car and hotel
 * ------------------------------------------------------------------ */

describe("a car rental's consent page on a manual-capture order", () => {
  it("calls today's amount a card hold, in the summary and in the breakdown row", () => {
    const text = pageText(view(CAR_SNAPSHOT, HOLD));
    expect(text).toContain(
      "Booking summaryCard hold today$249.99New booking" +
        "Card hold today$249.99" +
        "Remaining balance due at rental counter$100.00" +
        "Total rental cost$349.99",
    );
    expect(text).not.toMatch(PAY_NOW_WORDS);
  });

  it("submits with 'Confirm & Authorize Card', never 'Confirm & Continue to Payment'", () => {
    submitButton(view(CAR_SNAPSHOT, HOLD), "Confirm & Authorize Card");
    expect(screen.queryByRole("button", { name: "Confirm & Continue to Payment" })).toBeNull();
  });

  it("says the checkout places a hold, not a charge, and keeps the evidence sentence and support link", () => {
    expect(pageText(view(CAR_SNAPSHOT, HOLD))).toContain(HOLD_FOOTNOTE);
  });
});

describe("a car rental's consent page on an automatic order reads exactly as before", () => {
  it("keeps 'You are paying today', 'Paid online today', 'Confirm & Continue to Payment' and 'to complete payment'", () => {
    const text = pageText(view(CAR_SNAPSHOT));
    expect(text).toContain(
      "Booking summaryYou are paying today$249.99New booking" +
        "Paid online today$249.99" +
        "Remaining balance due at rental counter$100.00" +
        "Total rental cost$349.99",
    );
    expect(text).toContain(PAY_FOOTNOTE);
    expect(text).not.toContain("Card hold today");
    expect(text).not.toMatch(/\bhold\b|authori[sz]e/i);
    submitButton(view(CAR_SNAPSHOT), "Confirm & Continue to Payment");
  });
});

describe("a hotel's consent page on a manual-capture order", () => {
  it("calls today's amount a card hold beside the balance due at the property", () => {
    const text = pageText(view(HOTEL_SNAPSHOT, HOLD));
    expect(text).toContain(
      "Booking summaryCard hold today$300.00New booking" +
        "Card hold today$300.00" +
        "Remaining balance due at the property$50.00" +
        "Total hotel cost$350.00",
    );
    expect(text).not.toMatch(PAY_NOW_WORDS);
    expect(text).toContain(HOLD_FOOTNOTE);
  });

  it.each([
    ["frozen with its stay", { ...HOTEL_SNAPSHOT, hotel: STAY }],
    ["frozen before stays were", HOTEL_SNAPSHOT],
  ])("submits with 'Confirm & Authorize Card' when %s", (_case, snapshot) => {
    submitButton(view(snapshot, HOLD), "Confirm & Authorize Card");
  });
});

describe("a hotel's consent page on an automatic order reads exactly as before", () => {
  it("keeps 'You are paying today', 'Paid online today', 'Confirm & Continue to Payment' and 'to complete payment'", () => {
    const text = pageText(view({ ...HOTEL_SNAPSHOT, hotel: STAY }));
    expect(text).toContain(
      "Booking summaryYou are paying today$300.00New booking" +
        "Paid online today$300.00" +
        "Remaining balance due at the property$50.00" +
        "Total hotel cost$350.00",
    );
    expect(text).toContain(PAY_FOOTNOTE);
    expect(text).not.toMatch(/\bhold\b|authori[sz]e/i);
    submitButton(view({ ...HOTEL_SNAPSHOT, hotel: STAY }), "Confirm & Continue to Payment");
  });
});

/* ------------------------------------------------------------------ *
 * Flight
 * ------------------------------------------------------------------ */

/** The breakdown box for `flightWithCharge`, rows in order, ending on
 *  `settled` (what the collected amount is called today). */
function flightBreakdown(label: string, settled: string): string {
  return (
    "Airline ChargeNot collected through this payment link$400.00" +
    `${label}$100.00` +
    "Total Booking Value$500.00" +
    `${settled}$100.00` +
    "Airline Charge is shown for the total booking value and is not collected through this payment link."
  );
}

describe("an itinerary flight's consent page on a manual-capture order", () => {
  it.each([
    ["named by the operator", "Rental Cost", "Rental Cost"],
    ["stored before operators named it", "Service charge", "Service Charge"],
  ])("puts the charge %s on hold, in the summary and as the breakdown's last row", (_case, stored, name) => {
    const text = pageText(view(flightWithCharge(stored), HOLD));
    expect(text).toContain(`Booking summary${name} On Hold$100.00${name}New booking`);
    expect(text).toContain(flightBreakdown(name, `${name} On Hold`));
    expect(text).not.toContain("Amount Payable Now");
    expect(text).toContain(HOLD_FOOTNOTE);
    expect(text).not.toContain("complete payment");
  });

  it.each([
    ["Rental Cost", "Rental Cost"],
    ["Service charge", "Service Charge"],
  ])("submits with 'Confirm & authorize $100.00 <name>' for a charge stored as %s", (stored, name) => {
    submitButton(view(flightWithCharge(stored), HOLD), `Confirm & authorize $100.00 ${name}`);
    expect(screen.queryByRole("button", { name: /^Confirm & pay/ })).toBeNull();
  });
});

describe("an itinerary flight's consent page on an automatic order reads exactly as before", () => {
  it("keeps 'Amount Payable Now', 'Confirm & pay $100.00 Rental Cost' and 'to complete payment'", () => {
    const text = pageText(view(flightWithCharge("Rental Cost")));
    expect(text).toContain("Booking summaryAmount Payable Now$100.00Rental CostNew booking");
    expect(text).toContain(flightBreakdown("Rental Cost", "Amount Payable Now"));
    expect(text).toContain(PAY_FOOTNOTE);
    expect(text).not.toMatch(/On Hold|authori[sz]e/);
    submitButton(view(flightWithCharge("Rental Cost")), "Confirm & pay $100.00 Rental Cost");
  });
});

describe("a flight frozen BEFORE itineraries, on a manual-capture order", () => {
  it("reads 'Amount On Hold' in the summary and the breakdown's last row, never 'Amount Payable Now'", () => {
    const text = pageText(view(legacyFlightSnapshot(), HOLD));
    expect(text).toContain("Booking summaryAmount On Hold$420.50New booking");
    expect(text).toContain("Total Booking Value$420.50Amount On Hold$420.50");
    expect(text).not.toContain("Amount Payable Now");
    expect(text).toContain(HOLD_FOOTNOTE);
  });

  it("submits with 'Confirm & Authorize Card': it has no named charge to authorize", () => {
    submitButton(view(legacyFlightSnapshot(), HOLD), "Confirm & Authorize Card");
  });

  it("keeps 'Amount Payable Now' and 'Confirm & Continue to Payment' on an automatic order", () => {
    const text = pageText(view(legacyFlightSnapshot()));
    expect(text).toContain("Booking summaryAmount Payable Now$420.50New booking");
    expect(text).toContain("Total Booking Value$420.50Amount Payable Now$420.50");
    expect(text).not.toMatch(/On Hold|authori[sz]e/);
    submitButton(view(legacyFlightSnapshot()), "Confirm & Continue to Payment");
  });
});

/* ------------------------------------------------------------------ *
 * The redirect screen
 * ------------------------------------------------------------------ */

const HOLD_REDIRECT =
  "We've recorded your acknowledgement. You're being taken straight to Stripe Checkout to authorize your card — you won't be charged yet.";

const PAY_REDIRECT =
  "We've recorded your acknowledgement. You're being taken straight to Stripe Checkout to complete payment.";

/** A checkout link regenerated after the customer opened the page. */
const REGENERATED_URL = "https://checkout.example.test/pay/2";

describe("the redirect screen on the way to checkout", () => {
  /** jsdom cannot navigate, so `location.replace` is replaced by a spy:
   *  the redirect itself is what the customer experiences. */
  function captureRedirect(): ReturnType<typeof vi.fn> {
    const replace = vi.fn();
    vi.stubGlobal("location", { ...window.location, replace });
    return replace;
  }

  function respond(data: unknown): Response {
    return new Response(JSON.stringify({ ok: true, data }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("after the customer signs a hold, says the checkout will authorize their card — not charge it", async () => {
    const replace = captureRedirect();
    const fetchMock = vi.fn(async () => respond(signed(view(CAR_SNAPSHOT, HOLD))));
    vi.stubGlobal("fetch", fetchMock);

    const { user } = renderWithUser(
      <ConsentForm token="test-token" initialView={view(CAR_SNAPSHOT, HOLD)} branding={BRANDING} />,
    );
    await user.type(screen.getByLabelText(/digital signature/i), "Ada Lovelace");
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Confirm & Authorize Card" }));

    const shell = await screen.findByRole("status");
    expect(shell).toHaveTextContent("Opening secure checkout…");
    expect(shell).not.toHaveTextContent("Opening secure payment…");
    expect(shell).toHaveTextContent(HOLD_REDIRECT);
    expect(shell).not.toHaveTextContent("complete payment");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/consent/test-token",
      expect.objectContaining({ method: "POST" }),
    );
    expect(replace).toHaveBeenCalledWith(PAYMENT_URL);
  });

  it("after the customer signs an automatic order, still says 'to complete payment'", async () => {
    const replace = captureRedirect();
    vi.stubGlobal("fetch", vi.fn(async () => respond(signed(view(CAR_SNAPSHOT)))));

    const { user } = renderWithUser(
      <ConsentForm token="test-token" initialView={view(CAR_SNAPSHOT)} branding={BRANDING} />,
    );
    await user.type(screen.getByLabelText(/digital signature/i), "Ada Lovelace");
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Confirm & Continue to Payment" }));

    const shell = await screen.findByRole("status");
    expect(shell).toHaveTextContent(PAY_REDIRECT);
    expect(shell).not.toHaveTextContent(/authori[sz]e|charged yet/);
    expect(replace).toHaveBeenCalledWith(PAYMENT_URL);
  });

  // The operator regenerated the link between the page loading and the
  // customer signing. The button still reads as the page loaded; the
  // redirect screen describes the new link it is about to open.
  it.each([
    [
      "a link regenerated on manual capture is a hold",
      view(CAR_SNAPSHOT),
      "Confirm & Continue to Payment",
      { ...HOLD, paymentUrl: REGENERATED_URL },
      HOLD_REDIRECT,
    ],
    [
      "a link regenerated on automatic capture is a charge",
      view(CAR_SNAPSHOT, HOLD),
      "Confirm & Authorize Card",
      { paymentUrl: REGENERATED_URL },
      PAY_REDIRECT,
    ],
  ])(
    "words the redirect from the view returned on signing, not the page as loaded: %s",
    async (_case, initial, button, returned, sentence) => {
      const replace = captureRedirect();
      vi.stubGlobal("fetch", vi.fn(async () => respond(signed(view(CAR_SNAPSHOT, returned)))));

      const { user } = renderWithUser(
        <ConsentForm token="test-token" initialView={initial} branding={BRANDING} />,
      );
      await user.type(screen.getByLabelText(/digital signature/i), "Ada Lovelace");
      await user.click(screen.getByRole("checkbox"));
      await user.click(screen.getByRole("button", { name: button }));

      expect(await screen.findByRole("status")).toHaveTextContent(sentence);
      expect(replace).toHaveBeenCalledWith(REGENERATED_URL);
      expect(replace).not.toHaveBeenCalledWith(PAYMENT_URL);
    },
  );

  it.each([
    ["a hold", HOLD, HOLD_REDIRECT],
    ["an automatic order", {}, PAY_REDIRECT],
  ])("sends a customer who reopens a link they already signed straight on, worded for %s", (_case, over, sentence) => {
    const replace = captureRedirect();
    render(
      <ConsentForm
        token="test-token"
        initialView={signed(view(CAR_SNAPSHOT, over))}
        branding={BRANDING}
      />,
    );
    // No form again: straight to the redirect screen.
    expect(screen.queryByRole("button", { name: /^Confirm/ })).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(sentence);
    expect(replace).toHaveBeenCalledWith(PAYMENT_URL);
  });
});
