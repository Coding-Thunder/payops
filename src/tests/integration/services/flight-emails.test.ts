import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";

import { POST as previewRoute } from "@/app/api/orders/[id]/payment-request-preview/route";
import {
  DEFAULT_FLIGHT_CHARGE_NAME,
  FLIGHT_AMOUNT_LABELS,
  flightLabelsWithCharge,
  LEGACY_FLIGHT_AMOUNT_LABELS,
  LEGACY_FLIGHT_CHARGE_NAME,
} from "@/lib/charges";
import {
  BookingType,
  ConsentMode,
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
import { buildConsentMailto } from "@/server/email/consent-mailto";
import {
  createOrder,
  getOrderById,
  initiatePayment,
} from "@/server/services/order.service";
import { createProvider } from "@/server/services/provider.service";
import { createOrder as factoryCreateOrder } from "@/tests/factories/order.factory";
import { createSettings } from "@/tests/factories/settings.factory";
import { buildRequest, jsonBody } from "@/tests/utils/api";
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
 * for (airline charge / the collected charge / total booking value), and the
 * brand's FLIGHT terms — and none of the car-rental vocabulary a passenger
 * should never read. A car email keeps every string it had.
 *
 * The collected charge goes by the name the OPERATOR gave it ("Service
 * Charge" by default; "Processing Fee", "Rental Cost"…): that STORED name
 * labels its row, what was paid or held, and — on a new booking of an
 * itinerary flight — every sentence that asks for or confirms the payment.
 * The Airline Charge keeps its fixed label and is never collected. A
 * modification or cancellation charge shows its name in the rows but keeps
 * neutral sentences; one whose charge was never named (the pre-naming
 * "Service charge") reads neutrally throughout. A flight created BEFORE
 * itineraries usually charged its whole fare, so its copy stays generic.
 *
 * Every payment BUTTON and the default subject name a named charge, whatever
 * the booking type — never the airline. And the booking reference is ONE
 * value, the PNR: the confirmation shows it once, in its top block; the
 * request, the authorization and the consent mailto keep their "PNR" row.
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
/** The same round trip ($1,240 airline charge, $95 collected), its one
 *  charge line stored as `chargeName` — the name the operator gave it. */
const chargedRoundTrip = (
  chargeName: string,
  overrides: NonNullable<Parameters<typeof roundTripFlightInput>[0]> = {},
) =>
  linkedOrder(
    roundTripFlightInput({
      provider: "AIRINDIA",
      charges: flightServiceCharge(95, chargeName),
      ...overrides,
    }),
  );
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

/** An email's HTML as the customer reads it: tags dropped, React's text-node
 *  separators and escaped apostrophes undone, whitespace collapsed. */
function readable(html: string): string {
  return html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");
}

/** The money figure a breakdown row shows: the first one after the row's
 *  `label`, searching from `from` (the breakdown's title). */
function figureAfter(html: string, label: string, from: number): string | null {
  const at = html.indexOf(`>${label}<`, from);
  if (at < 0) return null;
  return /\$[\d,]+\.\d{2}/.exec(html.slice(at))?.[0] ?? null;
}

/** Mark `orderId`'s consent received, then return the payment button and the
 *  consent-mailto body its payment-request email would carry. */
async function consentedCta(orderId: string) {
  await Order.updateOne({ _id: orderId }, { $set: { "consent.status": ConsentStatus.RECEIVED } });
  actingAs(flightco);
  const props = await composePaymentRequestProps(await getOrderById(orderId, { actor }));
  return { label: props.primaryCta?.label, mailto: decodedMailtoBody(props.consentMailto!) };
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

  it("show the four rows — Airline Charge, Service Charge, Total Booking Value, the amount settled — and say the airline charge is not collected", async () => {
    const emails = await sendAllThree(await roundTrip());
    const settled = {
      request: FLIGHT_AMOUNT_LABELS.payableNow,
      confirmation: FLIGHT_AMOUNT_LABELS.paidNow,
      authorized: FLIGHT_AMOUNT_LABELS.heldNow,
    };
    for (const [name, email] of Object.entries(emails)) {
      expect(email.html, name).toContain(FLIGHT_AMOUNT_LABELS.breakdownTitle);
      for (const body of [email.html, email.text]) {
        expect(body, name).toContain(FLIGHT_AMOUNT_LABELS.airlineFare);
        expect(body, name).toContain(FLIGHT_AMOUNT_LABELS.airlineFareNote);
        expect(body, name).toContain(FLIGHT_AMOUNT_LABELS.serviceCharge);
        expect(body, name).toContain(FLIGHT_AMOUNT_LABELS.bookingTotal);
        expect(body, name).toContain(settled[name as keyof typeof settled]);
        expect(body, name).toContain(FLIGHT_AMOUNT_LABELS.airlineFareExplainer);
        expect(body, name).toContain("$1,240.00");
        expect(body, name).toContain("$95.00");
        expect(body, name).toContain("$1,335.00");
      }
      // In that order, in the breakdown.
      const from = email.html.indexOf(FLIGHT_AMOUNT_LABELS.breakdownTitle);
      const at = (label: string) => email.html.indexOf(`>${label}<`, from);
      const rows = [
        at(FLIGHT_AMOUNT_LABELS.airlineFare),
        at(FLIGHT_AMOUNT_LABELS.serviceCharge),
        at(FLIGHT_AMOUNT_LABELS.bookingTotal),
        at(settled[name as keyof typeof settled]),
        email.html.indexOf(FLIGHT_AMOUNT_LABELS.airlineFareExplainer, from),
      ];
      expect(rows[0], name).toBeGreaterThan(from);
      expect([...rows].sort((a, b) => a - b), name).toEqual(rows);
    }
  });

  it.each(["Rental Cost", "Processing Fee", "Agency Fee"])(
    "label the collected row with the operator's name — %s — beside the fixed Airline Charge row, each row with its own amount",
    async (chargeName) => {
      const order = await chargedRoundTrip(chargeName);
      const labels = flightLabelsWithCharge(chargeName);
      const settled = {
        request: labels.payableNow,
        confirmation: labels.paidNow,
        authorized: labels.heldNow,
      };
      // What was paid or held carries the operator's name too.
      expect(settled).toEqual({
        request: FLIGHT_AMOUNT_LABELS.payableNow,
        confirmation: `${chargeName} Paid`,
        authorized: `${chargeName} On Hold`,
      });

      const emails = await sendAllThree(order);
      for (const [name, email] of Object.entries(emails)) {
        const settledLabel = settled[name as keyof typeof settled];
        const from = email.html.indexOf(FLIGHT_AMOUNT_LABELS.breakdownTitle);
        expect(from, name).toBeGreaterThan(-1);
        // The rows, in order: the Airline Charge under its fixed label, then
        // the charge under the operator's name, the booking value and what
        // was settled, then the not-collected explainer.
        const at = (label: string) => email.html.indexOf(`>${label}<`, from);
        const rows = [
          at(FLIGHT_AMOUNT_LABELS.airlineFare),
          at(chargeName),
          at(FLIGHT_AMOUNT_LABELS.bookingTotal),
          at(settledLabel),
          email.html.indexOf(FLIGHT_AMOUNT_LABELS.airlineFareExplainer, from),
        ];
        expect(rows[0], name).toBeGreaterThan(from);
        expect([...rows].sort((a, b) => a - b), name).toEqual(rows);
        // Each row its own figure: the airline charge is never the amount
        // collected, and the operator's charge is exactly it.
        expect(figureAfter(email.html, FLIGHT_AMOUNT_LABELS.airlineFare, from), name).toBe("$1,240.00");
        expect(figureAfter(email.html, chargeName, from), name).toBe("$95.00");
        expect(figureAfter(email.html, FLIGHT_AMOUNT_LABELS.bookingTotal, from), name).toBe("$1,335.00");
        expect(figureAfter(email.html, settledLabel, from), name).toBe("$95.00");

        for (const body of [email.html, email.text]) {
          expect(body, name).toContain(chargeName);
          expect(body, name).toContain(settledLabel);
          expect(body, name).toContain(FLIGHT_AMOUNT_LABELS.airlineFare);
          expect(body, name).toContain(FLIGHT_AMOUNT_LABELS.airlineFareNote);
          expect(body, name).toContain(FLIGHT_AMOUNT_LABELS.bookingTotal);
          expect(body, name).toContain(FLIGHT_AMOUNT_LABELS.airlineFareExplainer);
          // The operator named the charge: the default never stands in for it.
          expect(body, name).not.toContain(DEFAULT_FLIGHT_CHARGE_NAME);
          expect(body.toLowerCase(), name).not.toContain("service charge");
        }
      }

      // The consent mailto the request email offers lists the same rows.
      const { mailto } = await consentedCta(order.id);
      expect(mailto).toContain(
        [
          "Airline Charge: 1240.00 USD (not collected through this payment link)",
          `${chargeName}: 95.00 USD`,
          "Total Booking Value: 1335.00 USD",
          "Amount Payable Now: 95.00 USD",
        ].join("\n"),
      );
      expect(mailto.toLowerCase()).not.toContain("service charge");
    },
  );

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

  // The default name, whether stored as the schema stores it today or as
  // the pre-naming "Service charge" (the fixtures' line) of an older order.
  it.each([DEFAULT_FLIGHT_CHARGE_NAME, LEGACY_FLIGHT_CHARGE_NAME])(
    "word each email around the charge's name — the default 'Service Charge' (stored as '%s')",
    async (stored) => {
      const order = await chargedRoundTrip(stored);
      const { request, confirmation, authorized } = await sendAllThree(order);
      const name = DEFAULT_FLIGHT_CHARGE_NAME;

      expect(request.html).toContain(FLIGHT_AMOUNT_LABELS.payableNow);
      expect(request.html).toContain(
        `please pay the ${name} using the secure link below to confirm it.`,
      );
      expect(request.html).toContain(FLIGHT_AMOUNT_LABELS.airlineFareExplainer);
      expect(request.html).toContain(`— $95.00 ${name}`);

      expect(confirmation.html).toContain(FLIGHT_AMOUNT_LABELS.paidNow);
      expect(confirmation.html).toContain(`received your ${name} payment`);

      expect(authorized.html).toContain(FLIGHT_AMOUNT_LABELS.heldNow);
      expect(authorized.html).toContain(`we charge exactly the $95.00 ${name}`);
      expect(authorized.html).toContain("The Airline Charge is not part of it.");
      expect(authorized.html).toContain(
        `Your bank may show the $95.00 ${name} as pending until then.`,
      );
    },
  );

  it("word every sentence around the operator's own name — never 'Service Charge' — in HTML and plain text", async () => {
    const order = await chargedRoundTrip("Processing Fee");
    const { request, confirmation, authorized } = await sendAllThree(order);

    // The inbox preview line and the small label under the amount.
    expect(request.html).toContain(
      `Complete payment for ${order.orderNumber} — $95.00 Processing Fee`,
    );
    expect(readable(request.html)).toContain(
      `${FLIGHT_AMOUNT_LABELS.payableNow} $95.00 Processing Fee`,
    );
    expect(confirmation.html).toContain(
      `FlightCo — payment confirmed for ${order.orderNumber} ($95.00 Processing Fee)`,
    );
    expect(authorized.html).toContain(
      `FlightCo — $95.00 Processing Fee held on your card for ${order.orderNumber}, not yet charged`,
    );

    for (const [kind, body] of [
      ["request html", readable(request.html)],
      ["request text", request.text],
    ] as const) {
      expect(body, kind).toContain(
        "is reserved — please pay the Processing Fee using the secure link below to confirm it.",
      );
    }
    for (const [kind, body] of [
      ["confirmation html", readable(confirmation.html)],
      ["confirmation text", confirmation.text],
    ] as const) {
      expect(body, kind).toContain("We've received your Processing Fee payment for");
      expect(body, kind).toContain("Processing Fee Paid");
    }
    for (const [kind, body] of [
      ["authorized html", readable(authorized.html)],
      ["authorized text", authorized.text],
    ] as const) {
      expect(body, kind).toContain(
        "Your card has been authorized for the $95.00 Processing Fee — this is a hold",
      );
      expect(body, kind).toContain(
        "Once it's confirmed we charge exactly the $95.00 Processing Fee — not a penny more",
      );
      expect(body, kind).toContain(
        "Your bank may show the $95.00 Processing Fee as pending until then.",
      );
      expect(body, kind).toContain("Processing Fee On Hold");
    }

    for (const [name, email] of Object.entries({ request, confirmation, authorized })) {
      for (const body of [email.html, email.text]) {
        expect(body, name).not.toContain(DEFAULT_FLIGHT_CHARGE_NAME);
        expect(body.toLowerCase(), name).not.toContain("service charge");
      }
    }
  });

  it.each([
    { stored: LEGACY_FLIGHT_CHARGE_NAME, shown: DEFAULT_FLIGHT_CHARGE_NAME },
    { stored: DEFAULT_FLIGHT_CHARGE_NAME, shown: DEFAULT_FLIGHT_CHARGE_NAME },
    { stored: "Processing Fee", shown: "Processing Fee" },
    { stored: "Rental Cost", shown: "Rental Cost" },
  ])(
    "names the charge on a consented customer's button — stored '$stored' reads '$shown'",
    async ({ stored, shown }) => {
      const order = await chargedRoundTrip(stored);
      const { label } = await consentedCta(order.id);
      expect(label).toBe(`Pay the $95.00 ${shown} securely with Stripe →`);
    },
  );

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

describe("a flight with no airline charge", () => {
  // 0 is what the form takes when there is none; null is a flight stored
  // before the airline charge was required.
  it.each([
    { airlineFare: 0, what: "an airline charge of 0" },
    { airlineFare: null, what: "no airline charge recorded (an older flight)" },
  ])("$what: leaves the airline row out — never '$0.00' — and totals the service charge alone", async ({ airlineFare }) => {
    const order = await linkedOrder(
      oneWayConnectingFlightInput(
        { provider: "AIRINDIA", charges: flightServiceCharge(60) },
        { airlineFare: airlineFare as never },
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
    expect(authorized.html).not.toContain("Airline Charge is not part of it");

    actingAs(flightco);
    const body = decodedMailtoBody((await composePaymentRequestProps(order)).consentMailto!);
    expect(body).toContain("Service Charge: 60.00 USD");
    expect(body).not.toContain("Airline Charge");
    expect(body).toContain("Total Booking Value: 60.00 USD");
    expect(body).toContain("Amount Payable Now: 60.00 USD");
  });
});

describe("a MODIFICATION of an itinerary flight keeps its sentences neutral", () => {
  /** What every modification email says, named or not: the generic
   *  sentences, the airline charge shown and not collected, the itinerary. */
  function expectNeutralModificationEmails(emails: Awaited<ReturnType<typeof sendAllThree>>) {
    const { request, confirmation, authorized } = emails;
    for (const [name, email] of Object.entries(emails)) {
      for (const body of [email.html, email.text]) {
        expect(body.toLowerCase(), name).not.toContain("service charge");
        // No sentence asks for, or confirms, the payment by a charge name.
        expect(body, name).not.toContain("please pay the");
        // The airline charge is still shown — and still not collected.
        expect(body, name).toContain(LEGACY_FLIGHT_AMOUNT_LABELS.airlineFare);
        expect(body, name).toContain(LEGACY_FLIGHT_AMOUNT_LABELS.airlineFareExplainer);
      }
      // Still a flight email, with its whole itinerary.
      expect(email.html, name).toContain("1. Mumbai → Varanasi");
      expect(email.html, name).toContain(FLIGHT_PROVIDER_LABEL);
    }
    expect(request.html).toContain(LEGACY_FLIGHT_AMOUNT_LABELS.payableNow);
    expect(request.html).toContain(
      "please complete payment using the secure link below to confirm it.",
    );
    expect(readable(confirmation.html)).toContain("We've received your payment for");
    expect(readable(authorized.html)).toContain(
      "Your card has been authorized for $95.00 — this is a hold",
    );
    expect(readable(authorized.html)).toContain(
      "Your bank may show $95.00 as pending until then.",
    );
  }

  it("labels its rows with the operator's name for the charge — 'Change Fee' — and only its buttons ask for it by that name", async () => {
    const order = await chargedRoundTrip("Change Fee", {
      bookingType: BookingType.MODIFICATION,
    });
    const labels = flightLabelsWithCharge("Change Fee");
    const emails = await sendAllThree(order);
    expectNeutralModificationEmails(emails);
    // A payment button names the charge it collects, whatever the booking
    // type: the request's consent button here, the pay button below.
    expect(readable(emails.request.html)).toContain("Review & pay $95.00 Change Fee");

    for (const [name, email] of Object.entries(emails)) {
      const from = email.html.indexOf(FLIGHT_AMOUNT_LABELS.breakdownTitle);
      expect(figureAfter(email.html, "Change Fee", from), name).toBe("$95.00");
      expect(figureAfter(email.html, FLIGHT_AMOUNT_LABELS.airlineFare, from), name).toBe("$1,240.00");
      // Its name, not the neutral wording of a charge nobody named.
      expect(email.html, name).not.toContain(LEGACY_FLIGHT_AMOUNT_LABELS.serviceCharge);
    }
    // The inbox preview line stays neutral too.
    expect(emails.request.html).toContain(`Complete payment for ${order.orderNumber} — $95.00<`);
    expect(emails.confirmation.html).toContain(labels.paidNow);
    expect(emails.authorized.html).toContain(labels.heldNow);
    expect(labels.paidNow).toBe("Change Fee Paid");
    expect(labels.heldNow).toBe("Change Fee On Hold");

    const { label, mailto } = await consentedCta(order.id);
    expect(label).toBe("Pay the $95.00 Change Fee securely with Stripe →");
    expect(mailto).toContain("Change Fee: 95.00 USD");
    expect(mailto).toContain(`${LEGACY_FLIGHT_AMOUNT_LABELS.payableNow}: 95.00 USD`);
  });

  it("reads 'Charged Online' when its charge was never named — the pre-naming 'Service charge', written straight to the database", async () => {
    const created = await chargedRoundTrip("Change Fee", {
      bookingType: BookingType.MODIFICATION,
    });
    // Bypasses the schema, which would store the default name in its place.
    await Order.collection.updateOne(
      { _id: new Types.ObjectId(created.id) },
      { $set: { "charges.0.name": LEGACY_FLIGHT_CHARGE_NAME } },
    );
    actingAs(flightco);
    const order = await getOrderById(created.id, { actor });
    expect(order.charges.map((c) => c.name)).toEqual([LEGACY_FLIGHT_CHARGE_NAME]);

    const emails = await sendAllThree(order);
    expectNeutralModificationEmails(emails);
    for (const [name, email] of Object.entries(emails)) {
      const from = email.html.indexOf(FLIGHT_AMOUNT_LABELS.breakdownTitle);
      expect(figureAfter(email.html, LEGACY_FLIGHT_AMOUNT_LABELS.serviceCharge, from), name).toBe(
        "$95.00",
      );
      expect(email.html, name).not.toContain("Change Fee");
    }
    expect(emails.confirmation.html).toContain(LEGACY_FLIGHT_AMOUNT_LABELS.paidNow);
    expect(emails.authorized.html).toContain(LEGACY_FLIGHT_AMOUNT_LABELS.heldNow);

    const { label, mailto } = await consentedCta(order.id);
    expect(label).toBe("Pay $95.00 securely with Stripe →");
    expect(mailto).toContain(`${LEGACY_FLIGHT_AMOUNT_LABELS.serviceCharge}: 95.00 USD`);
    expect(mailto).toContain(`${LEGACY_FLIGHT_AMOUNT_LABELS.payableNow}: 95.00 USD`);
  });
});

describe("the per-order preview and the email actually sent read the STORED charge name", () => {
  /** The composer's preview of `orderId`'s payment-request email. */
  async function composerPreview(orderId: string): Promise<string> {
    actingAs(flightco);
    const res = await previewRoute(
      buildRequest(`/api/orders/${orderId}/payment-request-preview`, {
        method: "POST",
        body: {},
      }),
      { params: Promise.resolve({ id: orderId }) },
    );
    const { status, body } = await jsonBody<{ ok: boolean; data: { html: string } }>(res);
    expect(status, JSON.stringify(body)).toBe(200);
    return body.data.html;
  }

  it("name the same charge — and both follow a change to the stored name, every amount untouched", async () => {
    const created = await chargedRoundTrip("Rental Cost");
    const before = await composerPreview(created.id);
    await sendPaymentRequestEmail(created, {}, { actor });
    for (const html of [before, lastSent(EmailKind.PAYMENT_LINK).html]) {
      expect(readable(html)).toContain(
        "please pay the Rental Cost using the secure link below to confirm it.",
      );
      expect(html).toContain(">Rental Cost<");
    }

    // The persisted name is the source of truth: change it and both follow.
    await Order.collection.updateOne(
      { _id: new Types.ObjectId(created.id) },
      { $set: { "charges.0.name": "Processing Fee" } },
    );
    const after = await composerPreview(created.id);
    actingAs(flightco);
    const renamed = await getOrderById(created.id, { actor });
    await sendPaymentRequestEmail(renamed, {}, { actor });
    const sent = lastSent(EmailKind.PAYMENT_LINK);

    for (const [kind, html] of [
      ["preview", after],
      ["sent", sent.html],
    ] as const) {
      const from = html.indexOf(FLIGHT_AMOUNT_LABELS.breakdownTitle);
      expect(readable(html), kind).toContain(
        "please pay the Processing Fee using the secure link below to confirm it.",
      );
      expect(readable(html), kind).toContain(
        `${FLIGHT_AMOUNT_LABELS.payableNow} $95.00 Processing Fee`,
      );
      expect(html, kind).not.toContain("Rental Cost");
      expect(html.toLowerCase(), kind).not.toContain("service charge");
      // Only the label moved: every row keeps its figure.
      expect(figureAfter(html, FLIGHT_AMOUNT_LABELS.airlineFare, from), kind).toBe("$1,240.00");
      expect(figureAfter(html, "Processing Fee", from), kind).toBe("$95.00");
      expect(figureAfter(html, FLIGHT_AMOUNT_LABELS.bookingTotal, from), kind).toBe("$1,335.00");
      expect(figureAfter(html, FLIGHT_AMOUNT_LABELS.payableNow, from), kind).toBe("$95.00");
    }
    expect(sent.text).toContain("please pay the Processing Fee using the secure link below");
    expect(sent.text).not.toContain("Rental Cost");
    expect(renamed.pricing.amount).toBe(95);
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
 * The booking reference — ONE value, the flight's PNR
 * ------------------------------------------------------------------ */

/** The decoded "Confirm by email" mailto a payment request carries. */
function consentMailtoIn(html: string): string {
  const mailto = [...html.matchAll(/href="(mailto:[^"]+)"/g)]
    .map((m) => decodeURIComponent(m[1]!.replace(/&amp;/g, "&")))
    .find((m) => m.includes("Acknowledgement"));
  expect(mailto, "the payment request has no consent mailto").toBeTruthy();
  return mailto!;
}

describe("a flight's booking reference is ONE value — its PNR — shown once", () => {
  /** The round trip with its ONE reference AXXXYY (the order's
   *  `confirmationNumber`, nothing in the legacy slot) — every flight
   *  created since the reference moved. */
  async function referencedRoundTrip(): Promise<OrderDTO> {
    const created = await roundTrip();
    await Order.collection.updateOne(
      { _id: new Types.ObjectId(created.id) },
      { $set: { confirmationNumber: "AXXXYY", "flight.pnr": null } },
    );
    actingAs(flightco);
    return getOrderById(created.id, { actor });
  }

  /** An OLDER round trip holding two different references, written straight
   *  to the database: the airline PNR OLDPNR1 its create form stored in the
   *  legacy slot, and a supplier number AXXXYY pasted later. */
  async function twoReferenceRoundTrip(): Promise<OrderDTO> {
    const created = await roundTrip();
    await Order.collection.updateOne(
      { _id: new Types.ObjectId(created.id) },
      { $set: { confirmationNumber: "AXXXYY", "flight.pnr": "OLDPNR1" } },
    );
    actingAs(flightco);
    return getOrderById(created.id, { actor });
  }

  it("the confirmation opens with 'PNR AXXXYY' in its top block — and never prints it again as a row", async () => {
    const { confirmation } = await sendAllThree(await referencedRoundTrip());
    const text = readable(confirmation.html);
    expect(text).toContain(
      "please keep this email for your records. PNR AXXXYY Air India New booking Booking details",
    );
    // The booking details end at the passengers — no PNR row after them.
    expect(text).toContain("Passengers 2 adults, 1 child Flight itinerary");
    expect(text.split("AXXXYY")).toHaveLength(2);
    expect(text.split("PNR")).toHaveLength(2);
    for (const body of [confirmation.html, confirmation.text]) {
      expect(body).not.toContain("Confirmation number");
    }
  });

  it("the request and the authorization keep their 'PNR' row — the order's AXXXYY", async () => {
    const { request, authorized } = await sendAllThree(await referencedRoundTrip());
    for (const [name, email] of Object.entries({ request, authorized })) {
      expect(readable(email.html), name).toContain("Passengers 2 adults, 1 child PNR AXXXYY");
    }
  });

  it("the request's consent mailto still lists 'PNR: AXXXYY'", async () => {
    await sendPaymentRequestEmail(await referencedRoundTrip(), {}, { actor });
    const mailto = consentMailtoIn(lastSent(EmailKind.PAYMENT_LINK).html);
    expect(mailto).toContain("PNR: AXXXYY");
  });

  it("an OLDER flight holding two different references shows both, each under its own name — the supplier number is never called the PNR", async () => {
    const { confirmation, request, authorized } = await sendAllThree(await twoReferenceRoundTrip());
    const top = readable(confirmation.html);
    expect(top).toContain(
      "please keep this email for your records. Confirmation number AXXXYY Air India New booking Booking details",
    );
    expect(top).toContain("Passengers 2 adults, 1 child PNR OLDPNR1");
    for (const [name, email] of Object.entries({ confirmation, request, authorized })) {
      expect(readable(email.html), name).not.toContain("PNR AXXXYY");
    }
    for (const [name, email] of Object.entries({ request, authorized })) {
      expect(readable(email.html), name).toContain("Passengers 2 adults, 1 child PNR OLDPNR1");
    }
    await sendPaymentRequestEmail(await twoReferenceRoundTrip(), {}, { actor });
    const mailto = consentMailtoIn(lastSent(EmailKind.PAYMENT_LINK).html);
    expect(mailto).toContain("PNR: OLDPNR1");
    expect(mailto).not.toContain("PNR: AXXXYY");
  });

  it("a flight with no reference yet shows no top block and no PNR row", async () => {
    const created = await roundTrip();
    await Order.collection.updateOne(
      { _id: new Types.ObjectId(created.id) },
      { $set: { confirmationNumber: null, "flight.pnr": null } },
    );
    actingAs(flightco);
    const { confirmation, request } = await sendAllThree(
      await getOrderById(created.id, { actor }),
    );
    expect(readable(confirmation.html)).toContain(
      "please keep this email for your records. Air India New booking Booking details",
    );
    for (const email of [confirmation, request]) {
      expect(email.html).not.toContain("PNR");
    }
  });
});

/* ------------------------------------------------------------------ *
 * The buttons and the subject name the collected charge
 * ------------------------------------------------------------------ */

describe("a flight's payment request names the charge it collects — its buttons and its subject", () => {
  it("asks for consent with 'Review & pay $95.00 Rental Cost', under 'Complete your Rental Cost payment' — never the airline's name", async () => {
    const order = await chargedRoundTrip("Rental Cost");
    await sendPaymentRequestEmail(order, {}, { actor });
    const request = lastSent(EmailKind.PAYMENT_LINK);
    expect(request.subject).toBe(`Complete your Rental Cost payment • ${order.orderNumber}`);
    expect(request.subject).not.toContain("Air India");
    const text = readable(request.html);
    expect(text).toContain("Review & pay $95.00 Rental Cost");
    expect(text).not.toContain("Review & Confirm Booking");
    expect(request.text).toContain("Review & pay $95.00 Rental Cost");
  });

  it("asks to 'Agree & pay $95.00 Rental Cost' where consent is required", async () => {
    await createSettings({ consentMode: ConsentMode.REQUIRED });
    const order = await chargedRoundTrip("Rental Cost");
    await sendPaymentRequestEmail(order, {}, { actor });
    const text = readable(lastSent(EmailKind.PAYMENT_LINK).html);
    expect(text).toContain("Agree & pay $95.00 Rental Cost");
    expect(text).not.toContain("Agree & Continue to Payment");
    expect(text).toContain("Confirmation is required before payment can be completed.");
  });

  it("names a modification's fee in its subject too — 'Complete your Change Fee payment'", async () => {
    const order = await chargedRoundTrip("Change Fee", { bookingType: BookingType.MODIFICATION });
    await sendPaymentRequestEmail(order, {}, { actor });
    expect(lastSent(EmailKind.PAYMENT_LINK).subject).toBe(
      `Complete your Change Fee payment • ${order.orderNumber}`,
    );
  });

  it("a charge nobody named keeps the generic buttons, and its subject names the flight — not the airline", async () => {
    const created = await chargedRoundTrip("Change Fee", { bookingType: BookingType.MODIFICATION });
    await Order.collection.updateOne(
      { _id: new Types.ObjectId(created.id) },
      { $set: { "charges.0.name": LEGACY_FLIGHT_CHARGE_NAME } },
    );
    actingAs(flightco);
    const order = await getOrderById(created.id, { actor });
    await sendPaymentRequestEmail(order, {}, { actor });
    const request = lastSent(EmailKind.PAYMENT_LINK);
    expect(request.subject).toBe(`Complete your flight payment • ${order.orderNumber}`);
    expect(readable(request.html)).toContain("Review & Confirm Booking");
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

  it("keeps the historic subject, naming its provider", async () => {
    const order = await legacyFlightDto();
    await sendPaymentRequestEmail(order, {}, { actor });
    expect(lastSent(EmailKind.PAYMENT_LINK).subject).toBe(
      `Complete your Budget payment • ${order.orderNumber}`,
    );
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

  it("labels the consent mailto neutrally — itinerary flights list Airline Charge, Service Charge, Total Booking Value, Amount Payable Now", async () => {
    const legacyBody = decodedMailtoBody(
      buildConsentMailto({
        toEmail: "support@flightco.test",
        brandName: "FlightCo",
        order: await legacyFlightDto(),
        consentMessage: "I agree.",
      }),
    );
    expect(legacyBody).toContain("Amount Payable Now: 420.50 USD");
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
    expect(itineraryBody).toContain(
      [
        "Airline Charge: 1240.00 USD (not collected through this payment link)",
        "Service Charge: 95.00 USD",
        "Total Booking Value: 1335.00 USD",
        "Amount Payable Now: 95.00 USD",
      ].join("\n"),
    );
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
