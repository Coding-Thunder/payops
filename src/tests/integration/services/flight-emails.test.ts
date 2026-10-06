import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";

import { FLIGHT_AMOUNT_LABELS, LEGACY_FLIGHT_AMOUNT_LABELS } from "@/lib/charges";
import {
  BookingType,
  ConsentStatus,
  EmailKind,
  FlightTripType,
  OrderEvidenceEventType,
  OrderStatus,
  PaymentGatewayKey,
  PaymentTiming,
  RecordState,
  ServiceType,
  UserRole,
} from "@/lib/constants/enums";
import { FLIGHT_PROVIDER_LABEL } from "@/lib/constants/labels";
import {
  Order,
  OrderEvidence,
  Organization,
  OrganizationMember,
} from "@/server/db/models";
import { orgCookieName } from "@/server/auth/org-cookie";
import { AIRLINE_FARE_NOT_INCLUDED } from "@/server/email/components";
import { buildConsentMailto } from "@/server/email/consent-mailto";
import {
  createOrder,
  getOrderById,
  initiatePayment,
} from "@/server/services/order.service";
import { createProvider } from "@/server/services/provider.service";
import { createOrder as factoryCreateOrder } from "@/tests/factories/order.factory";
import { createSettings } from "@/tests/factories/settings.factory";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { ensureMongo } from "@/tests/utils/db";
import { setNextHeaders } from "@/tests/utils/next-headers";
import {
  flightJourneyInput,
  flightSegmentInput,
  flightServiceCharge,
  multiCityFlightInput,
  oneWayConnectingFlightInput,
  roundTripFlightInput,
  validCreateOrderInput,
} from "@/tests/fixtures/order-input.fixture";
import type { OrderDTO } from "@/types";

/**
 * The three customer emails — payment request, payment confirmation and
 * payment authorized — for a FLIGHT, set against the same emails for a car.
 *
 * A flight email must show the whole itinerary (every flight, every
 * recorded layover, in both directions), the money split the client asked
 * for (airline fare / service charge / total booking value), and the
 * brand's FLIGHT terms — and none of the car-rental vocabulary a passenger
 * should never read. A car email keeps every string it had.
 *
 * Two wordings for flights: an ITINERARY flight's payment is its service
 * charge, and the copy says so; a flight created BEFORE itineraries usually
 * charged its whole fare, so its copy stays generic.
 */

const { sentMail } = vi.hoisted(() => ({
  sentMail: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/server/email/smtp", () => ({
  getMailer: () => ({
    sendMail: async (m: Record<string, unknown>) => {
      sentMail.push({ ...m, __transport: "deployment" });
      return { messageId: "<dep>", response: "250" };
    },
  }),
  getMailerFor: (cfg: { host: string; user: string }) => ({
    sendMail: async (m: Record<string, unknown>) => {
      sentMail.push({ ...m, __transport: `org:${cfg.user}` });
      return { messageId: "<org>", response: "250" };
    },
  }),
  verifyMailer: async () => {},
  _resetOrgMailersForTests: () => {},
}));

const {
  composePaymentRequestProps,
  sendPaymentAuthorizedEmail,
  sendPaymentConfirmationEmail,
  sendPaymentRequestEmail,
} = await import("@/server/services/email.service");

const actor = actorFor(UserRole.ADMIN);

const FLIGHTCO_ENV = {
  ORG_FLIGHTCO_STRIPE_SECRET_KEY: "sk_test_flightco_only",
  ORG_FLIGHTCO_STRIPE_WEBHOOK_SECRET: "whsec_flightco_only",
};

/** FlightCo's own legal text — distinct per service. */
const FLIGHT_TERMS = "FLIGHTCO FLIGHT TERMS: every flight follows the operating airline conditions of carriage.";
const FLIGHT_POLICY = "FLIGHTCO FLIGHT POLICY: changes and refunds follow the fare rules of the ticket.";
const CAR_TERMS = "FLIGHTCO CAR TERMS: the main driver presents a full licence at the desk.";
const CAR_POLICY = "FLIGHTCO CAR POLICY: free cancellation up to two days before collection.";

/** What a passenger must never read in a flight email. */
const CAR_ONLY_PHRASES = [
  "Pick-up",
  "Drop-off",
  "Vehicle",
  "Total rental cost",
  "Rental provider",
];

let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;
let flightco: Types.ObjectId;

async function makeFlightCo(): Promise<Types.ObjectId> {
  const doc = await Organization.create({
    slug: "flightco",
    name: "flightco",
    brandName: "FlightCo",
    isDefault: false,
    payments: { provider: PaymentGatewayKey.STRIPE },
    serviceTypes: [ServiceType.CAR_RENTAL, ServiceType.FLIGHT],
    email: {
      fromName: "FlightCo",
      fromEmail: "no-reply@flightco.test",
      replyTo: "help@flightco.test",
    },
    support: { email: "support@flightco.test", phone: "+442079460000" },
    legal: {
      termsAndConditions: CAR_TERMS,
      termsVersion: "v2",
      cancellationPolicy: CAR_POLICY,
      cancellationPolicyVersion: "v2",
      services: {
        FLIGHT: {
          termsAndConditions: FLIGHT_TERMS,
          termsVersion: "v3",
          cancellationPolicy: FLIGHT_POLICY,
          cancellationPolicyVersion: "v3",
        },
      },
    },
  });
  const id = doc._id as Types.ObjectId;
  await OrganizationMember.create({
    organizationId: id,
    userId: new Types.ObjectId(actor.id),
    role: UserRole.ADMIN,
    status: RecordState.ACTIVE,
  });
  return id;
}

function actingAs(orgId: Types.ObjectId) {
  setNextHeaders({ cookies: { [orgCookieName()]: String(orgId) } });
}

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  sessionMock = await mockSession(actor);
  Object.assign(process.env, FLIGHTCO_ENV);
  sentMail.length = 0;
  flightco = await makeFlightCo();
  await createProvider(
    {
      key: "AIRINDIA",
      name: "Air India",
      logo: "/providers/air-india.png",
      primaryColor: "#C8102E",
      onPrimaryColor: "#FFFFFF",
      tagline: "",
      sortOrder: 0,
      serviceTypes: [ServiceType.FLIGHT],
    } as Parameters<typeof createProvider>[0],
    { actor },
  );
});

afterEach(() => {
  sessionMock?.restore();
  sessionMock = null;
  for (const k of Object.keys(FLIGHTCO_ENV)) delete process.env[k];
  setNextHeaders({});
});

/** Create an order in FlightCo and generate its (Stripe-stub) payment link. */
async function linkedOrder(input: Parameters<typeof createOrder>[0]): Promise<OrderDTO> {
  actingAs(flightco);
  const { order } = await createOrder(input, { actor });
  const { order: linked } = await initiatePayment(order.id, { actor });
  return linked;
}

const roundTrip = () => linkedOrder(roundTripFlightInput({ provider: "AIRINDIA" }));
const validFlightOrderInputFor = (outbound: ReturnType<typeof flightJourneyInput>) =>
  roundTripFlightInput(
    { provider: "AIRINDIA" },
    { tripType: FlightTripType.ONE_WAY, outbound, return: null },
  );
const carWithCounterBalance = () =>
  linkedOrder(
    validCreateOrderInput({
      charges: [
        { name: "Rental cost", amount: 249.99, timing: PaymentTiming.PREPAID },
        { name: "Deposit", amount: 100, timing: PaymentTiming.DUE_AT_COUNTER },
      ],
    }),
  );

interface SentEmail {
  subject: string;
  html: string;
  text: string;
}

function lastSent(kind: EmailKind): SentEmail {
  const msg = [...sentMail]
    .reverse()
    .find((m) => (m.headers as Record<string, string>)["X-Entity-Kind"] === kind);
  expect(msg, `no ${kind} email was sent`).toBeTruthy();
  return { subject: String(msg!.subject), html: String(msg!.html), text: String(msg!.text) };
}

/** Send all three customer emails for `order` and return them. */
async function sendAllThree(order: OrderDTO) {
  await sendPaymentRequestEmail(order, {}, { actor });
  await sendPaymentConfirmationEmail(order);
  await sendPaymentAuthorizedEmail(order);
  return {
    request: lastSent(EmailKind.PAYMENT_LINK),
    confirmation: lastSent(EmailKind.PAYMENT_CONFIRMATION),
    authorized: lastSent(EmailKind.PAYMENT_AUTHORIZED),
  };
}

function decodedMailtoBody(mailto: string): string {
  return decodeURIComponent(mailto.slice(mailto.indexOf("&body=") + "&body=".length));
}

/* ------------------------------------------------------------------ *
 * An itinerary flight
 * ------------------------------------------------------------------ */

describe("a round-trip flight's emails", () => {
  it("show every flight of both journeys and every recorded layover", async () => {
    const emails = await sendAllThree(await roundTrip());
    for (const [name, email] of Object.entries(emails)) {
      for (const route of [
        "1. Delhi → Varanasi",
        "2. Varanasi → Mumbai",
        "1. Mumbai → Varanasi",
        "2. Varanasi → Delhi",
      ]) {
        expect(email.html, `${name}: ${route}`).toContain(route);
      }
      expect(email.html, name).toContain("Layover: 2h 30m — Varanasi");
      // The return layover was overridden to 2h; the override is what shows.
      expect(email.html, name).toContain("Layover: 2h — Varanasi");
      expect(email.html, name).toContain("Change terminals");
      expect(email.html, name).toContain("Lounge access included");
      expect(email.html, name).toContain("Air India • AI123");
      expect(email.html, name).toContain("Sat, Oct 10, 2026");
      expect(email.html, name).toContain("10:30 AM → 12:00 PM");
      expect(email.html, name).toContain("Delhi → Varanasi → Mumbai · 1 stop");
    }
  });

  it("show the airline fare, service charge and total booking value", async () => {
    const emails = await sendAllThree(await roundTrip());
    for (const [name, email] of Object.entries(emails)) {
      expect(email.html, name).toContain(FLIGHT_AMOUNT_LABELS.breakdownTitle);
      expect(email.html, name).toContain(FLIGHT_AMOUNT_LABELS.airlineFare);
      expect(email.html, name).toContain(FLIGHT_AMOUNT_LABELS.airlineFareNote);
      expect(email.html, name).toContain(FLIGHT_AMOUNT_LABELS.serviceCharge);
      expect(email.html, name).toContain(FLIGHT_AMOUNT_LABELS.bookingTotal);
      expect(email.html, name).toContain("$1,240.00");
      expect(email.html, name).toContain("$95.00");
      expect(email.html, name).toContain("$1,335.00");
    }
  });

  it("carry the brand's FLIGHT terms and policy — not its car text", async () => {
    const emails = await sendAllThree(await roundTrip());
    for (const [name, email] of Object.entries(emails)) {
      expect(email.html, name).toContain(FLIGHT_TERMS);
      expect(email.html, name).toContain(FLIGHT_POLICY);
      expect(email.html, name).not.toContain(CAR_TERMS);
      expect(email.html, name).not.toContain(CAR_POLICY);
    }
  });

  it("contain none of the car-rental vocabulary, in HTML or plain text", async () => {
    const emails = await sendAllThree(await roundTrip());
    for (const [name, email] of Object.entries(emails)) {
      for (const body of [email.html, email.text]) {
        for (const phrase of CAR_ONLY_PHRASES) {
          expect(body, `${name} contains "${phrase}"`).not.toContain(phrase);
        }
        expect(body.toLowerCase(), `${name} mentions due at counter`).not.toContain(
          "due at counter",
        );
      }
      expect(email.html, name).toContain(FLIGHT_PROVIDER_LABEL);
    }
  });

  it("word each email around the service charge", async () => {
    const { request, confirmation, authorized } = await sendAllThree(await roundTrip());

    expect(request.html).toContain(FLIGHT_AMOUNT_LABELS.payableNow);
    expect(request.html).toContain(
      "please pay the service charge using the secure link below to confirm it.",
    );
    expect(request.html).toContain(AIRLINE_FARE_NOT_INCLUDED);
    expect(request.html).toContain("— $95.00 service charge");

    expect(confirmation.html).toContain(FLIGHT_AMOUNT_LABELS.paidNow);
    expect(confirmation.html).toContain("received your service charge payment");

    expect(authorized.html).toContain(FLIGHT_AMOUNT_LABELS.heldNow);
    expect(authorized.html).toContain("we charge exactly the $95.00 service charge");
    expect(authorized.html).toContain(
      "Your bank may show the $95.00 service charge as pending until then.",
    );
  });

  it("asks a consented customer to pay 'the service charge' on the button", async () => {
    const order = await roundTrip();
    await Order.updateOne({ _id: order.id }, { $set: { "consent.status": ConsentStatus.RECEIVED } });
    actingAs(flightco);
    const props = await composePaymentRequestProps(await getOrderById(order.id, { actor }));
    expect(props.primaryCta?.label).toBe(
      "Pay the $95.00 service charge securely with Stripe →",
    );
  });

  it("records the fare and booking value it showed in the evidence row", async () => {
    const order = await roundTrip();
    await sendPaymentRequestEmail(order, {}, { actor });
    const row = await OrderEvidence.findOne({
      orderId: new Types.ObjectId(order.id),
      eventType: OrderEvidenceEventType.PAYMENT_REQUEST_EMAIL_SENT,
    }).lean<{ payload: Record<string, unknown> } | null>();
    expect(row!.payload).toMatchObject({
      amount: "$95.00",
      airlineFare: "$1,240.00",
      bookingTotal: "$1,335.00",
    });
  });
});

describe("a multi-city flight's emails count flights, not stops", () => {
  it("say '3 flights' in the itinerary and in the consent mailto", async () => {
    const order = await linkedOrder(multiCityFlightInput({ provider: "AIRINDIA" }));
    await sendPaymentRequestEmail(order, {}, { actor });
    const { html } = lastSent(EmailKind.PAYMENT_LINK);

    expect(html).toContain("Delhi → Varanasi → Mumbai → Goa · 3 flights");
    expect(html).not.toContain("2 stops");

    actingAs(flightco);
    const props = await composePaymentRequestProps(order);
    const body = decodedMailtoBody(props.consentMailto!);
    expect(body).toContain(
      "Multi-city: Delhi → Varanasi → Mumbai → Goa • Sat, Oct 10, 2026 10:30 AM • 3 flights",
    );
    expect(body).not.toContain("stop");
  });
});

describe("a flight booked with no airline fare recorded", () => {
  it("leaves the fare row out — never '$0.00' — and totals the service charge alone", async () => {
    const order = await linkedOrder(
      oneWayConnectingFlightInput(
        { provider: "AIRINDIA", charges: flightServiceCharge(60) },
        { airlineFare: null },
      ),
    );
    const { request, confirmation, authorized } = await sendAllThree(order);
    for (const [name, email] of Object.entries({ request, confirmation, authorized })) {
      expect(email.html, name).not.toContain(FLIGHT_AMOUNT_LABELS.airlineFare);
      expect(email.html, name).not.toContain(FLIGHT_AMOUNT_LABELS.airlineFareNote);
      expect(email.html, name).toContain(FLIGHT_AMOUNT_LABELS.bookingTotal);
      expect(email.html, name).not.toContain("$0.00");
      // Still the service-charge model: it is an itinerary flight.
      expect(email.html, name).toContain(FLIGHT_AMOUNT_LABELS.serviceCharge);
    }

    actingAs(flightco);
    const body = decodedMailtoBody((await composePaymentRequestProps(order)).consentMailto!);
    expect(body).toContain("Service charge payable now: 60.00 USD");
    expect(body).not.toContain("Airline fare");
    expect(body).toContain("Total booking value: 60.00 USD");
  });
});

describe("a MODIFICATION of an itinerary flight keeps the generic wording", () => {
  it("never calls the payment a service charge, in any of the three emails", async () => {
    const order = await linkedOrder(
      roundTripFlightInput({
        provider: "AIRINDIA",
        bookingType: BookingType.MODIFICATION,
        // Named for what it is, so only the wording around it is under test.
        charges: flightServiceCharge(95, "Change fee"),
      }),
    );
    const { request, confirmation, authorized } = await sendAllThree(order);
    for (const [name, email] of Object.entries({ request, confirmation, authorized })) {
      for (const body of [email.html, email.text]) {
        expect(body.toLowerCase(), name).not.toContain("service charge");
        expect(body, name).not.toContain(AIRLINE_FARE_NOT_INCLUDED);
      }
      // Still a flight email, with its whole itinerary.
      expect(email.html, name).toContain("1. Mumbai → Varanasi");
      expect(email.html, name).toContain(FLIGHT_PROVIDER_LABEL);
    }
    expect(request.html).toContain(LEGACY_FLIGHT_AMOUNT_LABELS.payableNow);
    expect(confirmation.html).toContain(LEGACY_FLIGHT_AMOUNT_LABELS.paidNow);
    expect(authorized.html).toContain(LEGACY_FLIGHT_AMOUNT_LABELS.heldNow);

    await Order.updateOne({ _id: order.id }, { $set: { "consent.status": ConsentStatus.RECEIVED } });
    actingAs(flightco);
    const props = await composePaymentRequestProps(await getOrderById(order.id, { actor }));
    expect(props.primaryCta?.label).toBe("Pay $95.00 securely with Stripe →");
    expect(decodedMailtoBody(props.consentMailto!)).toContain(
      `${LEGACY_FLIGHT_AMOUNT_LABELS.payableNow}: 95.00 USD`,
    );
  });
});

describe("a flight that crosses the International Date Line", () => {
  it("names the arrival day, so 10:00 AM is not read as before take-off", async () => {
    const order = await linkedOrder(
      validFlightOrderInputFor(
        flightJourneyInput([
          flightSegmentInput("Tokyo", "Los Angeles", ["2026-10-12", "17:00"], ["2026-10-12", "10:00"], {
            airline: "Test Airways",
            flightNumber: "TA9",
          }),
        ]),
      ),
    );
    await sendPaymentRequestEmail(order, {}, { actor });
    const { html } = lastSent(EmailKind.PAYMENT_LINK);
    expect(html).toContain("5:00 PM → 10:00 AM (arrives Oct 12)");
  });
});

/* ------------------------------------------------------------------ *
 * A car rental — unchanged
 * ------------------------------------------------------------------ */

describe("a car rental's emails keep every car string", () => {
  it("still read as a car rental in all three emails", async () => {
    const { request, confirmation, authorized } = await sendAllThree(
      await carWithCounterBalance(),
    );
    for (const [name, email] of Object.entries({ request, confirmation, authorized })) {
      for (const phrase of [
        "Vehicle",
        "Pick-up",
        "Drop-off",
        "Provider",
        "Total rental cost",
        "(due at counter)",
        "Amount due at counter",
        "Toyota • Camry",
      ]) {
        expect(email.html, `${name}: ${phrase}`).toContain(phrase);
      }
      expect(email.html, name).toContain(CAR_TERMS);
      expect(email.html, name).not.toContain(FLIGHT_TERMS);
      expect(email.html, name).not.toContain(FLIGHT_PROVIDER_LABEL);
      expect(email.html, name).not.toContain(FLIGHT_AMOUNT_LABELS.bookingTotal);
      expect(email.html.toLowerCase(), name).not.toContain("service charge");
    }
    expect(request.html).toContain("You pay today");
    expect(confirmation.html).toContain("Amount paid");
    expect(authorized.html).toContain("Amount authorized");
  });

  it("keeps its consent mailto and payment button exactly as before", async () => {
    const order = await carWithCounterBalance();
    await Order.updateOne({ _id: order.id }, { $set: { "consent.status": ConsentStatus.RECEIVED } });
    actingAs(flightco);
    const props = await composePaymentRequestProps(await getOrderById(order.id, { actor }));
    expect(props.primaryCta?.label).toBe("Pay $249.99 securely with Stripe →");

    const body = decodedMailtoBody(props.consentMailto!);
    expect(body).toContain("Provider: Budget");
    expect(body).toContain("Vehicle: Toyota • Camry");
    expect(body).toMatch(/Pick-up: \d{1,2} \w{3} \d{4} • \d{2}:\d{2} UTC/);
    expect(body).toMatch(/Drop-off: \d{1,2} \w{3} \d{4} • \d{2}:\d{2} UTC/);
    expect(body).toContain("Amount: 249.99 USD");
  });

  it("records no flight money in its evidence row", async () => {
    const order = await carWithCounterBalance();
    await sendPaymentRequestEmail(order, {}, { actor });
    const row = await OrderEvidence.findOne({
      orderId: new Types.ObjectId(order.id),
      eventType: OrderEvidenceEventType.PAYMENT_REQUEST_EMAIL_SENT,
    }).lean<{ payload: Record<string, unknown> } | null>();
    expect(row!.payload.amount).toBe("$249.99");
    expect("airlineFare" in row!.payload).toBe(false);
    expect("bookingTotal" in row!.payload).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * A flight created BEFORE itineraries
 * ------------------------------------------------------------------ */

describe("a LEGACY flight's emails keep the generic wording", () => {
  /** A pre-itinerary flight in FlightCo: flat fields, its whole fare as a
   *  prepaid "Airfare" line, link already generated, customer consented. */
  async function legacyFlightDto(): Promise<OrderDTO> {
    const doc = await factoryCreateOrder({
      serviceType: ServiceType.FLIGHT,
      organizationId: flightco,
      status: OrderStatus.LINK_GENERATED,
      pricing: { amount: 420.5, currency: "USD" as never },
      consent: {
        status: ConsentStatus.RECEIVED,
        currentConsentId: null,
        requestedAt: null,
        receivedAt: null,
        verifiedAt: null,
        method: null,
      },
      flight: {
        tripType: "ONE_WAY",
        airline: "Test Airways",
        flightNumber: "TA123",
        origin: "LHR",
        destination: "JFK",
        departureDate: new Date("2026-11-01T09:15:00.000Z"),
        arrivalDate: new Date("2026-11-01T17:40:00.000Z"),
        cabinClass: "ECONOMY",
        passengers: { adults: 1, children: 0, infants: 0 },
      },
    });
    await Order.updateOne(
      { _id: doc._id },
      {
        $set: {
          "payment.gateway": PaymentGatewayKey.STRIPE,
          "payment.checkoutUrl": "https://checkout.stripe.com/c/pay/cs_test_legacy",
          "payment.stripeSessionId": "cs_test_legacy",
        },
      },
    );
    actingAs(flightco);
    return getOrderById(String(doc._id), { actor });
  }

  it("offers the historic 'Pay $X securely with Stripe →' button", async () => {
    const props = await composePaymentRequestProps(await legacyFlightDto());
    expect(props.primaryCta?.label).toBe("Pay $420.50 securely with Stripe →");
  });

  it("never calls the payment a service charge, nor says the fare is charged separately", async () => {
    const order = await legacyFlightDto();
    const { request, confirmation, authorized } = await sendAllThree(order);
    for (const [name, email] of Object.entries({ request, confirmation, authorized })) {
      for (const body of [email.html, email.text]) {
        expect(body.toLowerCase(), name).not.toContain("service charge");
        expect(body, name).not.toContain("not part of this payment");
        expect(body, name).not.toContain(FLIGHT_AMOUNT_LABELS.airlineFare);
      }
      // Still a flight email: its single flat flight, the flight provider
      // label, and no car vocabulary.
      expect(email.html, name).toContain("1. LHR → JFK");
      expect(email.html, name).toContain(FLIGHT_PROVIDER_LABEL);
      for (const phrase of CAR_ONLY_PHRASES) {
        expect(email.html, `${name} contains "${phrase}"`).not.toContain(phrase);
      }
    }
    expect(request.html).toContain(LEGACY_FLIGHT_AMOUNT_LABELS.payableNow);
    expect(request.html).toContain(
      "please complete payment using the secure link below to confirm it.",
    );
    expect(confirmation.html).toContain(LEGACY_FLIGHT_AMOUNT_LABELS.paidNow);
    expect(authorized.html).toContain(LEGACY_FLIGHT_AMOUNT_LABELS.heldNow);
    // Legacy times keep the UTC label they were captured with.
    expect(request.html).toContain("9:15 AM UTC → 5:40 PM UTC");
  });

  it("labels the consent mailto 'Amount payable now' — itinerary flights keep 'Service charge payable now'", async () => {
    const legacyBody = decodedMailtoBody(
      buildConsentMailto({
        toEmail: "support@flightco.test",
        brandName: "FlightCo",
        order: await legacyFlightDto(),
        consentMessage: "I agree.",
      }),
    );
    expect(legacyBody).toContain("Amount payable now: 420.50 USD");
    expect(legacyBody.toLowerCase()).not.toContain("service charge");
    expect(legacyBody).toContain(`${FLIGHT_PROVIDER_LABEL}: Budget`);
    expect(legacyBody).toContain("One way: LHR → JFK • Sun, Nov 1, 2026 9:15 AM UTC • direct");

    const itineraryBody = decodedMailtoBody(
      buildConsentMailto({
        toEmail: "support@flightco.test",
        brandName: "FlightCo",
        order: await roundTrip(),
        consentMessage: "I agree.",
      }),
    );
    expect(itineraryBody).toContain("Service charge payable now: 95.00 USD");
    expect(itineraryBody).toContain(
      "Airline fare: 1240.00 USD (charged separately — not part of this payment)",
    );
    expect(itineraryBody).toContain("Total booking value: 1335.00 USD");
    expect(itineraryBody).toContain(
      "Outbound: Delhi → Varanasi → Mumbai • Sat, Oct 10, 2026 10:30 AM • 1 stop",
    );
    expect(itineraryBody).toContain(
      "Return: Mumbai → Varanasi → Delhi • Thu, Oct 15, 2026 9:00 AM • 1 stop",
    );
    expect(itineraryBody).toContain("PNR: ABC123");
    expect(itineraryBody).not.toContain("Amount:");
    for (const phrase of CAR_ONLY_PHRASES) {
      expect(itineraryBody).not.toContain(phrase);
    }
  });
});
