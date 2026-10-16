import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Types } from "mongoose";

import { PATCH as legalRoute } from "@/app/api/admin/settings/legal/route";
import {
  GET as consentViewRoute,
  POST as confirmConsentRoute,
} from "@/app/api/consent/[token]/route";
import { POST as createOrderRoute } from "@/app/api/orders/route";
import { GET as getOrderRoute } from "@/app/api/orders/[id]/route";
import { POST as captureRoute } from "@/app/api/orders/[id]/capture/route";
import { POST as confirmationNumberRoute } from "@/app/api/orders/[id]/confirmation-number/route";
import { POST as generateLinkRoute } from "@/app/api/orders/[id]/generate-payment-link/route";
import { POST as previewRoute } from "@/app/api/orders/[id]/payment-request-preview/route";
import { POST as resendConfirmationRoute } from "@/app/api/orders/[id]/resend-confirmation/route";
import { POST as sendRequestRoute } from "@/app/api/orders/[id]/send-payment-request/route";
import { POST as paypalWebhookRoute } from "@/app/api/webhooks/paypal/[orgSlug]/route";
import { POST as stripeWebhookRoute } from "@/app/api/webhooks/stripe/[orgSlug]/route";
import AcknowledgePage from "@/app/acknowledge/[token]/page";
import ConsentPage from "@/app/consent/[token]/page";
import PaymentSuccessPage from "@/app/pay/success/page";
import { ConfirmationNumberCard } from "@/components/features/orders/confirmation-number-card";
import { OrderDetailsCard } from "@/components/features/orders/order-details-card";
import { OrderPaymentCard } from "@/components/features/orders/order-payment-card";
import {
  CaptureMode,
  EmailKind,
  OrderStatus,
  PaymentCaptureStatus,
  PaymentGatewayKey,
  PaymentTiming,
  RecordState,
  ServiceType,
  UserRole,
} from "@/lib/constants/enums";
import { Order, Organization, OrganizationMember } from "@/server/db/models";
import { orgCookieName } from "@/server/auth/org-cookie";
import { formatEmailDate, formatEmailDay } from "@/server/email/format";
import { _setPayPalFetchForTesting } from "@/server/payments/gateways/paypal";
import { createProvider } from "@/server/services/provider.service";
import { createSettings } from "@/tests/factories/settings.factory";
import {
  buildCheckoutCompleted,
  signWebhook,
} from "@/tests/factories/stripe-event.factory";
import {
  oneWayConnectingFlightInput,
  validCreateOrderInput,
  validHotelOrderInput,
} from "@/tests/fixtures/order-input.fixture";
import { getCurrentTestStripe } from "@/tests/setup/integration.setup";
import { buildRequest, jsonBody } from "@/tests/utils/api";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { ensureMongo } from "@/tests/utils/db";
import { setNextHeaders } from "@/tests/utils/next-headers";
import type { OrderDTO, PublicConsentView } from "@/types";

/**
 * THE TRIPRESERVATIONS-SHAPED MATRIX: two brands in one deployment, each
 * selling car rentals, flights and hotels — every service, every customer
 * surface, end to end, through the real route handlers.
 *
 *   Trip Brand    PayPal, automatic capture   TRIP CAR / FLIGHT / HOTEL TEST
 *   Other Brand   Stripe, MANUAL capture      OTHER CAR / FLIGHT / HOTEL TEST
 *
 * Each brand's own terms and policies are saved through Admin → Settings
 * (PATCH /api/admin/settings/legal) while working in that brand; the
 * suppliers are global (a car supplier, an airline, a hotel supplier).
 *
 * For each brand × service an operator — signed in, the brand selected —
 * creates the order (POST /api/orders), generates the link, previews and
 * sends the payment request; the customer opens the hosted consent page and
 * confirms; the gateway's webhooks settle it (Trip Brand: PayPal approve →
 * capture; Other Brand: Stripe authorization → AUTHORIZED email → the
 * operator's capture) and the outbox sends the confirmation; the operator
 * saves the booking reference (POST /api/orders/[id]/confirmation-number) and
 * resends the confirmation; the order page loads (GET /api/orders/[id]).
 * Every assertion is on what was RENDERED or SENT — the composer preview,
 * the emails as they left through SMTP (HTML, plain text, the consent
 * mailto), the consent / acknowledge / receipt pages, the operator's order
 * cards, and the request each gateway was asked to charge.
 *
 *   1. creation     the stored order, its money and the terms it froze
 *   2. gateway      exactly the collected amount, worded for the service
 *   3. request      composer preview + the sent email: own terms only, own
 *                   brand and contacts, the right processor, service rows
 *   4. consent      the hosted page the email's button opens
 *   5. payment      webhooks → confirmation; the booking reference saved and
 *                   resent under the service's own name, shown ONCE
 *   6. order page   the operator's cards from the order API
 *   7. cross-org    nothing of the other brand, anywhere
 *   8. charge name  (Trip Brand) renaming the flight's charge
 *
 * Car rental output is pinned to the strings brand-leak.test.ts pins.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: () => {},
    push: () => {},
    replace: () => {},
    back: () => {},
    prefetch: () => {},
  }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error("notFound");
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  },
}));

const { sentMail } = vi.hoisted(() => ({
  sentMail: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/server/email/smtp", () => ({
  getMailer: () => ({
    sendMail: async (m: Record<string, unknown>) => {
      sentMail.push({ ...m });
      return { messageId: "<deployment>", response: "250 OK" };
    },
  }),
  getMailerFor: () => ({
    sendMail: async (m: Record<string, unknown>) => {
      sentMail.push({ ...m });
      return { messageId: "<organization>", response: "250 OK" };
    },
  }),
  verifyMailer: async () => {},
  _resetOrgMailersForTests: () => {},
}));

const { drainPendingEmails } = await import("@/server/services/email-outbox.service");

/* ------------------------------------------------------------------ *
 * The deployment: two brands, three services, three global suppliers
 * ------------------------------------------------------------------ */

type OrgKey = "trip" | "other";
type Kind = "car" | "flight" | "hotel";

const ORG_KEYS: OrgKey[] = ["trip", "other"];
const KINDS: Kind[] = ["car", "flight", "hotel"];
const SERVICE_OF: Record<Kind, ServiceType> = {
  car: ServiceType.CAR_RENTAL,
  flight: ServiceType.FLIGHT,
  hotel: ServiceType.HOTEL,
};

interface OrgSpec {
  slug: string;
  brandName: string;
  gateway: PaymentGatewayKey;
  gatewayLabel: "PayPal" | "Stripe";
  captureMode: CaptureMode;
  supportEmail: string;
  supportPhone: string;
  fromEmail: string;
  replyTo: string;
  /** Each service's own terms / policy marker — no marker is a substring
   *  of another, none has an apostrophe (HTML escaping). */
  terms: Record<Kind, string>;
  policies: Record<Kind, string>;
  env: Record<string, string>;
}

const ORG: Record<OrgKey, OrgSpec> = {
  trip: {
    slug: "tripbrand",
    brandName: "Trip Brand",
    gateway: PaymentGatewayKey.PAYPAL,
    gatewayLabel: "PayPal",
    captureMode: CaptureMode.AUTOMATIC,
    supportEmail: "support@tripbrand.test",
    supportPhone: "+442070000001",
    fromEmail: "bookings@tripbrand.test",
    replyTo: "help@tripbrand.test",
    terms: { car: "TRIP CAR TEST", flight: "TRIP FLIGHT TEST", hotel: "TRIP HOTEL TEST" },
    policies: { car: "TRIP CAR POLICY", flight: "TRIP FLIGHT POLICY", hotel: "TRIP HOTEL POLICY" },
    env: {
      ORG_TRIPBRAND_PAYPAL_CLIENT_ID: "tripbrand-client-id",
      ORG_TRIPBRAND_PAYPAL_CLIENT_SECRET: "tripbrand-client-secret",
      ORG_TRIPBRAND_PAYPAL_WEBHOOK_ID: "WEBHOOK-TRIPBRAND",
      ORG_TRIPBRAND_PAYPAL_SANDBOX: "true",
    },
  },
  other: {
    slug: "otherbrand",
    brandName: "Other Brand",
    gateway: PaymentGatewayKey.STRIPE,
    gatewayLabel: "Stripe",
    captureMode: CaptureMode.MANUAL,
    supportEmail: "support@otherbrand.test",
    supportPhone: "+12125550199",
    fromEmail: "bookings@otherbrand.test",
    replyTo: "help@otherbrand.test",
    terms: { car: "OTHER CAR TEST", flight: "OTHER FLIGHT TEST", hotel: "OTHER HOTEL TEST" },
    policies: { car: "OTHER CAR POLICY", flight: "OTHER FLIGHT POLICY", hotel: "OTHER HOTEL POLICY" },
    env: {
      ORG_OTHERBRAND_STRIPE_SECRET_KEY: "sk_test_otherbrand_only",
      ORG_OTHERBRAND_STRIPE_WEBHOOK_SECRET: "whsec_otherbrand_only",
    },
  },
};

const ALL_ENV: Record<string, string> = { ...ORG.trip.env, ...ORG.other.env };

/** Apostrophe-free lines found only in each built-in / deployment default
 *  text — a brand with its own text must never fall back to any of them. */
const DEFAULT_TEXT_MARKERS = [
  "The prepaid amount is charged today to secure your reservation.",
  "Cancellations made more than 24 hours before pick-up are eligible for a full refund.",
  "The amount shown as payable now is the only amount collected through this payment.",
  "Changes and cancellations to airline tickets are governed by the fare rules of the ticket issued.",
  "Changes to the dates, rooms or guests may change the price and are subject to availability.",
  "Where a refund is due, it is made to your original payment method and is limited to the amount you paid online.",
];

/** The car supplier is created through the catalog exactly as the seed
 *  record (key, name, logo, colours), so a car order reads byte-for-byte
 *  what brand-leak.test.ts pins. */
const CAR_SUPPLIER = "Budget";
const AIRLINE = "Air India";
const HOTEL_SUPPLIER = "Harbour Stays";
const HOTEL_SUPPLIER_KEY = "HARBOURSTAYS";
const PROPERTY = "Harbour View Hotel";
const DESTINATION = "Lisbon, Portugal";
const ROOM_PREFERENCE = "King bed, high floor";
/** The operator's own note — it must never reach a customer. */
const GUEST_NOTES = "VIP guest, upgrade if available";
/** Calendar days, as the hotel create form posts them. */
const CHECK_IN = "2026-11-12";
const CHECK_OUT = "2026-11-15";
const STAY_ROWS =
  `Property ${PROPERTY} Destination ${DESTINATION} Check-in 12 Nov 2026 ` +
  `Check-out 15 Nov 2026 Rooms 1 room Guests 2 adults Room preference ${ROOM_PREFERENCE}`;

const FLIGHT_CHARGE = "Rental Cost";
const ROUTE = "Delhi → Varanasi → Mumbai";
const DEPARTS = "Departs: Sat, Oct 10, 2026 10:30 AM • One way, 1 stop";
const FLIGHT_ROWS = `Trip type One way Route ${ROUTE} Cabin Economy Passengers 1 adult`;

const EXPLAINER =
  "Airline Charge is shown for the total booking value and is not collected through this payment link.";

interface KindSpec {
  /** Who the booking is with — the email's provider badge and subject. */
  supplier: string;
  /** The ONE amount the payment link collects. */
  collected: number;
  /** Major-unit figures that must never reach the gateway… */
  neverCharged: string[];
  /** …and the same in minor units, never in Stripe's line items. */
  neverChargedMinor: string[];
  /** The booking reference the operator saves, and its name. */
  reference: string;
  referenceLabel: string;
  receiptLabel: string;
  referenceNoun: string;
  referenceHelp: string;
  /** The operator card's provider eyebrow. */
  providerLabel: string;
}

const KIND: Record<Kind, KindSpec> = {
  car: {
    supplier: CAR_SUPPLIER,
    collected: 249.99,
    neverCharged: ["349.99", "100.00"],
    neverChargedMinor: ["34999", "10000"],
    reference: "CR-7781",
    referenceLabel: "Confirmation number",
    receiptLabel: "Confirmation #",
    referenceNoun: "confirmation number",
    referenceHelp:
      "Paste the supplier confirmation number. It appears at the top of the customer's confirmation email.",
    providerLabel: "Rental provider",
  },
  flight: {
    supplier: AIRLINE,
    collected: 100,
    neverCharged: ["400.00", "500.00"],
    neverChargedMinor: ["40000", "50000"],
    reference: "AXXXYY",
    referenceLabel: "PNR",
    receiptLabel: "PNR",
    referenceNoun: "PNR",
    referenceHelp:
      "Paste the airline booking reference (PNR). It appears at the top of the customer's confirmation email.",
    providerLabel: "Airline / Supplier",
  },
  hotel: {
    supplier: HOTEL_SUPPLIER,
    collected: 300,
    neverCharged: ["50.00", "350.00"],
    neverChargedMinor: ["5000", "35000"],
    reference: "HC-55120",
    referenceLabel: "Hotel confirmation number",
    receiptLabel: "Hotel confirmation #",
    referenceNoun: "hotel confirmation number",
    referenceHelp:
      "Paste the hotel's confirmation number. It appears at the top of the customer's confirmation email.",
    providerLabel: "Hotel / Supplier",
  },
};

/** Words of a car rental a hotel customer must never read. */
const CAR_WORDS = ["rental", "vehicle", "pick-up", "drop-off", "counter"];
/** …and a flight's (whose charge here is NAMED "Rental Cost"). */
const FLIGHT_FORBIDDEN_CAR_WORDS = ["vehicle", "pick-up", "drop-off", "counter"];
/** A flight's and a hotel's money words a car customer never reads. */
const NOT_CAR_WORDS = [
  "Airline Charge",
  "Total Booking Value",
  "Amount Payable Now",
  "Price breakdown",
  "at the property",
  "Total hotel cost",
];

const money = (n: number) => `$${n.toFixed(2)}`;

const operator = actorFor(UserRole.ADMIN, { name: "Olivia Operator" });

let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;
const orgIds = {} as Record<OrgKey, Types.ObjectId>;
/** Every PayPal API call the stub answered (OAuth excepted), in order. */
let paypalCalls: { url: string; body: unknown }[] = [];
let paypalOrderSeq = 0;
let ipSeq = 0;

/** A fresh client address per rate-limited call (consent submit, capture),
 *  so the in-process limiter never sees the whole file as one caller. */
function uniqueIp(): string {
  ipSeq += 1;
  return `10.42.${Math.floor(ipSeq / 250)}.${ipSeq % 250}`;
}

async function makeOrg(key: OrgKey): Promise<Types.ObjectId> {
  const spec = ORG[key];
  const doc = await Organization.create({
    slug: spec.slug,
    name: spec.slug,
    brandName: spec.brandName,
    isDefault: false,
    payments: { provider: spec.gateway, captureMode: spec.captureMode },
    serviceTypes: [ServiceType.CAR_RENTAL, ServiceType.FLIGHT, ServiceType.HOTEL],
    email: { fromName: spec.brandName, fromEmail: spec.fromEmail, replyTo: spec.replyTo },
    support: { email: spec.supportEmail, phone: spec.supportPhone },
  });
  const id = doc._id as Types.ObjectId;
  await OrganizationMember.create({
    organizationId: id,
    userId: new Types.ObjectId(operator.id),
    role: operator.role,
    status: RecordState.ACTIVE,
  });
  return id;
}

/** The operator, signed in, working in `key`'s brand. */
async function actingAs(key: OrgKey) {
  sessionMock?.restore();
  sessionMock = await mockSession(operator);
  setNextHeaders({ cookies: { [orgCookieName()]: String(orgIds[key]) } });
}

/** A customer's browser or a gateway: no session, no organization. */
function anonymous() {
  sessionMock?.restore();
  sessionMock = null;
  setNextHeaders({});
}

/** Minimal PayPal API: OAuth, order creation, webhook verification (always
 *  SUCCESS) and capture — recording every call. */
function stubPayPal() {
  paypalCalls = [];
  _setPayPalFetchForTesting((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (url.includes("/v1/oauth2/token")) {
      return json({ access_token: "tok", expires_in: 3600 });
    }
    const raw = init?.body ? String(init.body) : "";
    paypalCalls.push({ url, body: raw.startsWith("{") ? JSON.parse(raw) : raw });
    if (url.includes("/v1/notifications/verify-webhook-signature")) {
      return json({ verification_status: "SUCCESS" });
    }
    if (url.endsWith("/capture")) {
      return json({ id: url.split("/").at(-2), status: "COMPLETED" });
    }
    paypalOrderSeq += 1;
    const id = `PP-MATRIX-${paypalOrderSeq}`;
    return json({
      id,
      status: "PAYER_ACTION_REQUIRED",
      links: [{ rel: "payer-action", href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }],
    });
  }) as unknown as typeof fetch);
}

/** Admin → Settings, working in `key`'s brand: save its own terms and
 *  policy for one service (PATCH /api/admin/settings/legal). */
async function saveOwnLegal(key: OrgKey, kind: Kind) {
  await actingAs(key);
  const res = await legalRoute(
    buildRequest("/api/admin/settings/legal", {
      method: "PATCH",
      body: {
        serviceType: SERVICE_OF[kind],
        termsAndConditions: `${ORG[key].terms[kind]} — clause one of these terms.`,
        cancellationPolicy: `${ORG[key].policies[kind]} — rule one of this policy.`,
      },
    }),
  );
  const { status, body } = await jsonBody(res);
  expect(status, JSON.stringify(body)).toBe(200);
}

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  Object.assign(process.env, ALL_ENV);
  sentMail.length = 0;
  stubPayPal();
  for (const key of ORG_KEYS) orgIds[key] = await makeOrg(key);
  await actingAs("trip");
  // Global suppliers: no organization restriction — both brands book them.
  const suppliers = [
    { key: "BUDGET", name: CAR_SUPPLIER, serviceType: ServiceType.CAR_RENTAL, logo: "/providers/budget.png", primaryColor: "#E8590C", tagline: "Value-focused rentals" },
    { key: "AIRINDIA", name: AIRLINE, serviceType: ServiceType.FLIGHT, logo: "/providers/air-india.png", primaryColor: "#C8102E", tagline: "" },
    { key: HOTEL_SUPPLIER_KEY, name: HOTEL_SUPPLIER, serviceType: ServiceType.HOTEL, logo: "/providers/preview.png", primaryColor: "#0B3D91", tagline: "" },
  ];
  for (const s of suppliers) {
    await createProvider(
      {
        key: s.key,
        name: s.name,
        logo: s.logo,
        primaryColor: s.primaryColor,
        onPrimaryColor: "#FFFFFF",
        tagline: s.tagline,
        sortOrder: 0,
        serviceTypes: [s.serviceType],
      } as Parameters<typeof createProvider>[0],
      { actor: operator },
    );
  }
  for (const key of ORG_KEYS) {
    for (const kind of KINDS) await saveOwnLegal(key, kind);
  }
});

afterEach(() => {
  sessionMock?.restore();
  sessionMock = null;
  _setPayPalFetchForTesting(null);
  for (const k of Object.keys(ALL_ENV)) delete process.env[k];
  setNextHeaders({});
});

/* ------------------------------------------------------------------ *
 * Reading what the customer reads
 * ------------------------------------------------------------------ */

/** The text a reader sees in rendered HTML: no head, no tags, entities and
 *  React's text-node separators resolved, whitespace collapsed. */
function visibleText(html: string): string {
  return html
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[­͏​-‏⁠﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** An email's plain-text part, whitespace collapsed. */
function plainText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Raw content with every percent-encoded run decoded — so a brand name or
 *  address inside a mailto/tel link (or the plain text's raw links) is read
 *  as the customer's mail client would read it. */
function decoded(content: string): string {
  return content
    .replace(/&amp;/g, "&")
    .replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
      try {
        return decodeURIComponent(run);
      } catch {
        return run;
      }
    });
}

/** Everything a surface can say: raw, visible and decoded. */
function everything(content: string): string {
  return [content, visibleText(content), decoded(content)].join("\n");
}

/** The money block of a rendered page or email: from its title to the end
 *  of the Airline Charge explainer that closes it. */
function moneyBlock(html: string, title = "Price breakdown"): string {
  const text = visibleText(html);
  const from = text.indexOf(title);
  expect(from, `no "${title}" block`).toBeGreaterThanOrEqual(0);
  const to = text.indexOf(EXPLAINER, from);
  expect(to, `"${title}" does not end with the Airline Charge explainer`).toBeGreaterThan(from);
  return text.slice(from, to + EXPLAINER.length);
}

/** An EMAIL's flight rows: label then amount, the airline row's note under it. */
function emailMoney(chargeName: string, settledLabel: string): string {
  return [
    "Airline Charge", "$400.00", "Not collected through this payment link",
    chargeName, "$100.00",
    "Total Booking Value", "$500.00",
    settledLabel, "$100.00",
    EXPLAINER,
  ].join(" ");
}

/** A PAGE's flight rows: the airline row's note sits inside its label. */
function pageMoney(chargeName: string, settledLabel: string): string {
  return [
    "Airline Charge", "Not collected through this payment link", "$400.00",
    chargeName, "$100.00",
    "Total Booking Value", "$500.00",
    settledLabel, "$100.00",
    EXPLAINER,
  ].join(" ");
}

/** The decoded "Confirm by email" mailto a payment request carries. */
function consentMailto(html: string): string {
  const mailtos = [...html.matchAll(/href="(mailto:[^"]+)"/g)].map((m) =>
    decodeURIComponent(m[1]!.replace(/&amp;/g, "&")),
  );
  const consent = mailtos.find((m) => m.includes("Acknowledgement"));
  expect(consent, "the payment request has no consent mailto").toBeTruthy();
  return consent!;
}

/** Every value under a key that names money, anywhere in a gateway request. */
function amountsIn(value: unknown): unknown[] {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, v]) =>
    /amount/i.test(key) ? [v] : amountsIn(v),
  );
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/* ------------------------------------------------------------------ *
 * What the operator, the customer and the gateways do — real routes
 * ------------------------------------------------------------------ */

interface SentEmail {
  subject: string;
  html: string;
  text: string;
  from: string;
  replyTo: string;
}

function sentSince(mark: number, kind: EmailKind): SentEmail[] {
  return sentMail
    .slice(mark)
    .filter((m) => (m.headers as Record<string, string>)["X-Entity-Kind"] === kind)
    .map((m) => ({
      subject: String(m.subject),
      html: String(m.html),
      text: String(m.text),
      from: String(m.from ?? ""),
      replyTo: String(m.replyTo ?? ""),
    }));
}

function onlySentSince(mark: number, kind: EmailKind): SentEmail {
  const found = sentSince(mark, kind);
  expect(found, `expected exactly one ${kind} email`).toHaveLength(1);
  return found[0]!;
}

const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

async function ok<T>(res: Response, status = 200): Promise<T> {
  const { status: got, body } = await jsonBody<{ ok: boolean; data: T }>(res);
  expect(got, JSON.stringify(body)).toBe(status);
  return body.data;
}

/** The create form's body for each service. */
function orderBody(kind: Kind, chargeName = FLIGHT_CHARGE) {
  switch (kind) {
    case "car":
      // The existing car payload (brand-leak.test.ts' pins): a prepaid rental
      // line and a deposit settled at the counter.
      return validCreateOrderInput({
        charges: [
          { name: "Rental cost", amount: 249.99, timing: PaymentTiming.PREPAID },
          { name: "Deposit", amount: 100, timing: PaymentTiming.DUE_AT_COUNTER },
        ],
      });
    case "flight":
      // The airline charge in its own field; ONE charge, named by the
      // operator, is what the link collects. No PNR yet — it arrives later.
      return oneWayConnectingFlightInput(
        {
          provider: "AIRINDIA",
          charges: [{ name: chargeName, amount: 100, timing: PaymentTiming.PREPAID }],
        },
        { airlineFare: 400, pnr: null },
      );
    case "hotel":
      return validHotelOrderInput({
        provider: HOTEL_SUPPLIER_KEY,
        hotel: {
          destination: DESTINATION,
          propertyName: PROPERTY,
          checkInDate: CHECK_IN,
          checkOutDate: CHECK_OUT,
          rooms: 1,
          guests: { adults: 2, children: 0 },
          roomPreference: ROOM_PREFERENCE,
          guestNotes: GUEST_NOTES,
        },
        charges: [
          { name: "Room charge", amount: 300, timing: PaymentTiming.PREPAID },
          { name: "Resort fee", amount: 50, timing: PaymentTiming.DUE_AT_COUNTER },
        ],
      });
  }
}

/** POST /api/orders — the create form's submit. */
async function submitOrder(key: OrgKey, body: unknown): Promise<OrderDTO> {
  await actingAs(key);
  const { order } = await ok<{ order: OrderDTO }>(
    await createOrderRoute(buildRequest("/api/orders", { method: "POST", body })),
    201,
  );
  return order;
}

interface PayPalOrderBody {
  purchase_units: {
    custom_id: string;
    description: string;
    amount: { currency_code: string; value: string };
  }[];
  payment_source: { paypal: { experience_context: { brand_name: string } } };
}

/** POST /api/orders/[id]/generate-payment-link — exactly as the composer
 *  posts it (it always says `gateway: "STRIPE"`; the brand's own provider
 *  must win). Returns every gateway request it made. */
async function generateLink(key: OrgKey, orderId: string) {
  await actingAs(key);
  const stripeBefore = getCurrentTestStripe().sessionsCreated.length;
  const paypalBefore = paypalCalls.length;
  const { order } = await ok<{ order: OrderDTO }>(
    await generateLinkRoute(
      buildRequest(`/api/orders/${orderId}/generate-payment-link`, {
        method: "POST",
        body: { gateway: PaymentGatewayKey.STRIPE },
      }),
      idParams(orderId),
    ),
  );
  return {
    order,
    stripe: getCurrentTestStripe()
      .sessionsCreated.slice(stripeBefore)
      .map((s) => s.params),
    paypal: paypalCalls
      .slice(paypalBefore)
      .filter((c) => c.url.endsWith("/v2/checkout/orders"))
      .map((c) => c.body as PayPalOrderBody),
  };
}

/** POST /api/orders/[id]/payment-request-preview — the composer's preview. */
async function composerPreview(key: OrgKey, orderId: string): Promise<string> {
  await actingAs(key);
  const { html } = await ok<{ html: string }>(
    await previewRoute(
      buildRequest(`/api/orders/${orderId}/payment-request-preview`, { method: "POST", body: {} }),
      idParams(orderId),
    ),
  );
  return html;
}

/** POST /api/orders/[id]/send-payment-request — the email actually sent. */
async function sendRequest(key: OrgKey, orderId: string) {
  await actingAs(key);
  const mark = sentMail.length;
  const data = await ok<{ order: OrderDTO; sent: { consentToken: string | null } }>(
    await sendRequestRoute(
      buildRequest(`/api/orders/${orderId}/send-payment-request`, { method: "POST", body: {} }),
      idParams(orderId),
    ),
  );
  expect(data.sent.consentToken, "the send recorded no consent request").toBeTruthy();
  return {
    order: data.order,
    consentToken: data.sent.consentToken!,
    email: onlySentSince(mark, EmailKind.PAYMENT_LINK),
  };
}

/** /consent/[token] — the hosted page the email's button opens. */
async function consentPage(token: string): Promise<string> {
  anonymous();
  return renderToStaticMarkup(await ConsentPage({ params: Promise.resolve({ token }) }));
}

/** The customer signs and confirms (GET, then POST /api/consent/[token]). */
async function confirmConsent(token: string, signedName: string) {
  anonymous();
  const view = await ok<PublicConsentView>(
    await consentViewRoute(buildRequest(`/api/consent/${token}`), {
      params: Promise.resolve({ token }),
    }),
  );
  await ok<PublicConsentView>(
    await confirmConsentRoute(
      buildRequest(`/api/consent/${token}`, {
        method: "POST",
        body: { acknowledgement: view.consentMessage, signedName },
        headers: { "x-forwarded-for": uniqueIp() },
      }),
      { params: Promise.resolve({ token }) },
    ),
  );
}

/** A PayPal delivery as PayPal sends it: the five transmission headers. */
function paypalDelivery(slug: string, event: Record<string, unknown>) {
  return new Request(`http://localhost/api/webhooks/paypal/${slug}`, {
    method: "POST",
    headers: new Headers({
      "content-type": "application/json",
      "paypal-transmission-id": `tx-${String(event.id)}`,
      "paypal-transmission-time": new Date().toISOString(),
      "paypal-cert-url": "https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT",
      "paypal-auth-algo": "SHA256withRSA",
      "paypal-transmission-sig": "sig",
    }),
    body: JSON.stringify(event),
  }) as never;
}

/** A Stripe delivery: the raw payload and its signature header. */
function stripeDelivery(slug: string, payload: string, signature: string) {
  return new Request(`http://localhost/api/webhooks/stripe/${slug}`, {
    method: "POST",
    headers: new Headers({ "content-type": "application/json", "stripe-signature": signature }),
    body: payload,
  }) as never;
}

type WebhookReply = { status: number; body: { ok: boolean; data: Record<string, unknown> } };

/** Trip Brand: PayPal's CHECKOUT.ORDER.APPROVED to the brand's PayPal
 *  endpoint (which captures — approval is not payment), then
 *  PAYMENT.CAPTURE.COMPLETED, then the outbox run that sends the email. */
async function payWithPayPal(key: OrgKey, order: OrderDTO, kind: Kind) {
  const slug = ORG[key].slug;
  const sessionId = order.payment.paymentSessionId!;
  anonymous();
  const callsBefore = paypalCalls.length;
  const approved: WebhookReply = await jsonBody(
    await paypalWebhookRoute(
      paypalDelivery(slug, {
        id: `WH-APPROVED-${order.id}`,
        event_type: "CHECKOUT.ORDER.APPROVED",
        create_time: new Date().toISOString(),
        resource: { id: sessionId, status: "APPROVED", purchase_units: [{ custom_id: order.id }] },
      }),
      { params: Promise.resolve({ orgSlug: slug }) },
    ),
  );
  const capturesAsked = paypalCalls
    .slice(callsBefore)
    .filter((c) => c.url.endsWith(`/v2/checkout/orders/${sessionId}/capture`)).length;
  const afterApproval = await Order.findById(order.id).lean<{ status: string } | null>();
  const drainedAfterApproval = await drainPendingEmails(10);
  const completed: WebhookReply = await jsonBody(
    await paypalWebhookRoute(
      paypalDelivery(slug, {
        id: `WH-COMPLETED-${order.id}`,
        event_type: "PAYMENT.CAPTURE.COMPLETED",
        create_time: new Date().toISOString(),
        resource: {
          id: `CAP-${order.orderNumber}`,
          status: "COMPLETED",
          custom_id: order.id,
          amount: { currency_code: "USD", value: KIND[kind].collected.toFixed(2) },
          supplementary_data: { related_ids: { order_id: sessionId } },
        },
      }),
      { params: Promise.resolve({ orgSlug: slug }) },
    ),
  );
  const mark = sentMail.length;
  const drained = await drainPendingEmails(10);
  return {
    approved,
    capturesAsked,
    statusAfterApproval: afterApproval?.status ?? null,
    drainedAfterApproval,
    completed,
    drained,
    confirmation: onlySentSince(mark, EmailKind.PAYMENT_CONFIRMATION),
  };
}

/** Other Brand: Stripe's checkout.session.completed with payment_status
 *  "unpaid" (manual capture: an AUTHORIZATION), signed with the brand's own
 *  secret, to the brand's Stripe endpoint; then the outbox run. */
async function authorizeWithStripe(key: OrgKey, order: OrderDTO, kind: Kind) {
  const slug = ORG[key].slug;
  anonymous();
  const payload = JSON.stringify(
    buildCheckoutCompleted({
      orderId: order.id,
      orderNumber: order.orderNumber,
      sessionId: order.payment.paymentSessionId!,
      paymentIntentId: order.payment.paymentIntentId!,
      amountTotal: Math.round(KIND[kind].collected * 100),
      paymentStatus: "unpaid",
    }),
  );
  const secret = ORG[key].env[`ORG_${slug.toUpperCase()}_STRIPE_WEBHOOK_SECRET`]!;
  const delivered: WebhookReply = await jsonBody(
    await stripeWebhookRoute(stripeDelivery(slug, payload, signWebhook(payload, secret)), {
      params: Promise.resolve({ orgSlug: slug }),
    }),
  );
  const afterAuthorization = await Order.findById(order.id).lean<{
    status: string;
    payment: { capture: { status: string; amountAuthorized: number | null } | null };
  } | null>();
  const mark = sentMail.length;
  const drained = await drainPendingEmails(10);
  return {
    delivered,
    afterAuthorization: afterAuthorization!,
    drained,
    authorized: onlySentSince(mark, EmailKind.PAYMENT_AUTHORIZED),
  };
}

/** Other Brand: the operator captures the hold (POST /api/orders/[id]/capture),
 *  then the outbox run that sends the confirmation. */
async function captureWithStripe(key: OrgKey, orderId: string) {
  await actingAs(key);
  const capturesBefore = getCurrentTestStripe().capturesRequested.length;
  const { order } = await ok<{ order: OrderDTO }>(
    await captureRoute(
      buildRequest(`/api/orders/${orderId}/capture`, {
        method: "POST",
        body: {},
        headers: { "x-forwarded-for": uniqueIp() },
      }),
      idParams(orderId),
    ),
  );
  const captures = getCurrentTestStripe().capturesRequested.slice(capturesBefore);
  anonymous();
  const mark = sentMail.length;
  const drained = await drainPendingEmails(10);
  return {
    order,
    captures,
    drained,
    confirmation: onlySentSince(mark, EmailKind.PAYMENT_CONFIRMATION),
  };
}

/** POST /api/orders/[id]/confirmation-number — the order card's Save. */
async function saveReference(key: OrgKey, orderId: string, reference: string): Promise<OrderDTO> {
  await actingAs(key);
  return ok<OrderDTO>(
    await confirmationNumberRoute(
      buildRequest(`/api/orders/${orderId}/confirmation-number`, {
        method: "POST",
        body: { confirmationNumber: reference },
      }),
      idParams(orderId),
    ),
  );
}

/** POST /api/orders/[id]/resend-confirmation — the card's resend button. */
async function resendConfirmation(key: OrgKey, orderId: string) {
  await actingAs(key);
  const mark = sentMail.length;
  const data = await ok<{ order: OrderDTO; emailId: string | null }>(
    await resendConfirmationRoute(
      buildRequest(`/api/orders/${orderId}/resend-confirmation`, { method: "POST", body: {} }),
      idParams(orderId),
    ),
  );
  return { ...data, email: onlySentSince(mark, EmailKind.PAYMENT_CONFIRMATION) };
}

/** GET /api/orders/[id] — what the operator's order page loads. */
async function orderApi(key: OrgKey, orderId: string): Promise<OrderDTO> {
  await actingAs(key);
  return ok<OrderDTO>(await getOrderRoute(buildRequest(`/api/orders/${orderId}`), idParams(orderId)));
}

/** The order page's cards, rendered from the order API. */
function renderCards(order: OrderDTO) {
  return {
    details: renderToStaticMarkup(<OrderDetailsCard order={order} />),
    payment: renderToStaticMarkup(<OrderPaymentCard order={order} canRegenerate={false} />),
    reference: renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <ConfirmationNumberCard order={order} />
      </QueryClientProvider>,
    ),
  };
}

/** /pay/success — where the gateway returns the customer (PayPal appends
 *  `token`, Stripe `session_id`). */
async function receiptPage(key: OrgKey, order: OrderDTO): Promise<string> {
  anonymous();
  const returned =
    ORG[key].gateway === PaymentGatewayKey.PAYPAL
      ? { token: order.payment.paymentSessionId! }
      : { session_id: order.payment.paymentSessionId! };
  return renderToStaticMarkup(
    await PaymentSuccessPage({
      searchParams: Promise.resolve({ order: order.orderNumber, ...returned }),
    }),
  );
}

/** /acknowledge/[token] — the page the confirmation's "I Agree" opens: the
 *  one customer PAGE that prints the order's terms. */
async function acknowledgePage(confirmationHtml: string): Promise<string> {
  const token = /href="[^"]*\/acknowledge\/([^"?#/]+)"/.exec(confirmationHtml)?.[1];
  expect(token, "the confirmation has no I Agree link").toBeTruthy();
  anonymous();
  return renderToStaticMarkup(await AcknowledgePage({ params: Promise.resolve({ token: token! }) }));
}

async function storedOrder(orderId: string) {
  const doc = await Order.findById(orderId).lean<{
    organizationId: Types.ObjectId;
    serviceType: string;
    charges: { name: string; amount: number; timing: string }[];
    pricing: { amount: number; currency: string };
    confirmationNumber?: string | null;
    flight?: { airlineFare: number | null; pnr?: string | null } | null;
    hotel?: {
      checkInDate: Date;
      checkOutDate: Date;
      roomPreference: string | null;
      guestNotes: string | null;
    } | null;
    terms: { text: string };
    policy: { text: string };
  } | null>();
  expect(doc, `order ${orderId} was not stored`).toBeTruthy();
  return doc!;
}

/* ------------------------------------------------------------------ *
 * Journeys, in stages
 * ------------------------------------------------------------------ */

/** Created, linked, previewed and sent. */
async function startJourney(key: OrgKey, kind: Kind, chargeName = FLIGHT_CHARGE) {
  const created = await submitOrder(key, orderBody(kind, chargeName));
  const stored = await storedOrder(created.id);
  const link = await generateLink(key, created.id);
  const preview = await composerPreview(key, created.id);
  const request = await sendRequest(key, created.id);
  return {
    key,
    kind,
    created,
    stored,
    link,
    /** The "Due …" line every real payment request prints after the order
     *  number, once its link exists. */
    due: formatEmailDate(link.order.payment.expiresAt!),
    preview,
    request,
  };
}

type Started = Awaited<ReturnType<typeof startJourney>>;

/** …the customer opens the hosted page and confirms; the composer's
 *  preview now offers the pay button. */
async function throughConsent(started: Started) {
  const consent = await consentPage(started.request.consentToken);
  await confirmConsent(started.request.consentToken, started.created.customer.name);
  const previewAfterConsent = await composerPreview(started.key, started.created.id);
  return { ...started, consent, previewAfterConsent };
}

/** …paid through the brand's gateway; the booking reference saved and the
 *  confirmation resent; the order page loaded. */
async function fullJourney(key: OrgKey, kind: Kind) {
  const consented = await throughConsent(await startJourney(key, kind));
  const { created, link } = consented;
  const paypal =
    ORG[key].gateway === PaymentGatewayKey.PAYPAL ? await payWithPayPal(key, link.order, kind) : null;
  const authorization =
    ORG[key].gateway === PaymentGatewayKey.STRIPE ? await authorizeWithStripe(key, link.order, kind) : null;
  const capture =
    ORG[key].gateway === PaymentGatewayKey.STRIPE ? await captureWithStripe(key, created.id) : null;
  const paid = await orderApi(key, created.id);
  const referenceSaved = await saveReference(key, created.id, KIND[kind].reference);
  const resend = await resendConfirmation(key, created.id);
  const detail = await orderApi(key, created.id);
  return {
    ...consented,
    paypal,
    authorization,
    capture,
    confirmation: (paypal?.confirmation ?? capture?.confirmation)!,
    paid,
    referenceSaved,
    resend,
    detail,
    cards: renderCards(detail),
    receipt: await receiptPage(key, detail),
    acknowledge: await acknowledgePage(resend.email.html),
  };
}

type Finished = Awaited<ReturnType<typeof fullJourney>>;

/* ------------------------------------------------------------------ *
 * What every surface must (and must never) carry
 * ------------------------------------------------------------------ */

/** Every terms / policy text in the deployment other than `key`'s own for
 *  `kind` — the other two services', the other brand's three, and every
 *  default a brand with its own text must never fall back to. */
function foreignTexts(key: OrgKey, kind: Kind): string[] {
  const out: string[] = [];
  for (const k of ORG_KEYS) {
    for (const s of KINDS) {
      if (k === key && s === kind) continue;
      out.push(ORG[k].terms[s], ORG[k].policies[s]);
    }
  }
  return [...out, ...DEFAULT_TEXT_MARKERS];
}

/**
 * Own service's terms ONLY. `shows` says what the surface prints of its
 * own: both texts (every email), the terms alone (the acknowledge page), or
 * none (pages that print no T&C — they must still carry no other's).
 */
function expectOwnTermsOnly(
  key: OrgKey,
  kind: Kind,
  surfaces: Record<string, string>,
  shows: "terms+policy" | "terms" | "none",
) {
  for (const [where, content] of Object.entries(surfaces)) {
    if (shows !== "none") {
      expect(content, `${where} must show "${ORG[key].terms[kind]}"`).toContain(ORG[key].terms[kind]);
    }
    if (shows === "terms+policy") {
      expect(content, `${where} must show "${ORG[key].policies[kind]}"`).toContain(
        ORG[key].policies[kind],
      );
    }
    const all = everything(content);
    for (const marker of foreignTexts(key, kind)) {
      expect(all, `${where} must NOT show "${marker}"`).not.toContain(marker);
    }
  }
}

/** The brand an email names — its name, its support address and phone. */
function expectEmailBrand(key: OrgKey, where: string, email: SentEmail) {
  const org = ORG[key];
  expect(visibleText(email.html), `${where}: brand name`).toContain(org.brandName);
  expect(visibleText(email.html), `${where}: footer`).toContain(
    `${org.brandName}. Automated`,
  );
  expect(email.html, `${where}: support address`).toContain(`mailto:${org.supportEmail}`);
  expect(email.html, `${where}: support phone`).toContain(`tel:${org.supportPhone}`);
  expect(email.from, `${where}: From`).toBe(`${org.brandName} <${org.fromEmail}>`);
  expect(email.replyTo, `${where}: Reply-To`).toBe(org.replyTo);
}

/** The processor named is the brand's own — and the other is never named. */
function expectOnlyGateway(key: OrgKey, surfaces: Record<string, string>) {
  const never = ORG[key].gatewayLabel === "PayPal" ? /stripe/i : /paypal/i;
  for (const [where, content] of Object.entries(surfaces)) {
    expect(content, `${where} names the other brand's processor`).not.toMatch(never);
  }
}

/** Words of another service never reach this one's customer. */
function expectNoWords(words: string[], surfaces: Record<string, string>, caseInsensitive = true) {
  for (const [where, content] of Object.entries(surfaces)) {
    const read = [visibleText(content), plainText(decoded(content))].join("\n");
    for (const word of words) {
      if (caseInsensitive) {
        expect(read.toLowerCase(), `${where} says "${word}"`).not.toContain(word.toLowerCase());
      } else {
        expect(read, `${where} says "${word}"`).not.toContain(word);
      }
    }
  }
}

/** Everything of a brand that would identify it to another's customer. */
function brandMarkers(key: OrgKey): string[] {
  const o = ORG[key];
  return [
    o.brandName,
    o.slug,
    o.supportEmail,
    o.supportPhone,
    o.fromEmail,
    o.replyTo,
    ...KINDS.flatMap((k) => [o.terms[k], o.policies[k]]),
  ];
}

/** Every surface a journey produced, customer and operator alike. */
function surfacesOf(j: Finished): Record<string, string> {
  const email = (name: string, e: SentEmail | null | undefined): Record<string, string> =>
    e
      ? {
          [`${name} (html)`]: e.html,
          [`${name} (text)`]: e.text,
          [`${name} (subject)`]: e.subject,
          [`${name} (From / Reply-To)`]: `${e.from} ${e.replyTo}`,
        }
      : {};
  return {
    "composer preview": j.preview,
    "composer preview after consent": j.previewAfterConsent,
    ...email("payment request", j.request.email),
    "consent page": j.consent,
    ...email("authorization", j.authorization?.authorized),
    ...email("confirmation", j.confirmation),
    ...email("resent confirmation", j.resend.email),
    "acknowledge page": j.acknowledge,
    receipt: j.receipt,
    "order API": JSON.stringify(j.detail),
    "order details card": j.cards.details,
    "order payment card": j.cards.payment,
    "booking reference card": j.cards.reference,
    "gateway request": JSON.stringify([...j.link.paypal, ...j.link.stripe]),
  };
}

/* ------------------------------------------------------------------ *
 * The matrix
 * ------------------------------------------------------------------ */

const ORG_TITLE: Record<OrgKey, string> = {
  trip: "Trip Brand — PayPal, automatic capture, sells car rental · flight · hotel",
  other: "Other Brand — Stripe, MANUAL capture, sells car rental · flight · hotel",
};

const TITLES: Record<Kind, (key: OrgKey) => Record<1 | 2 | 3 | 4 | 5 | 6, string>> = {
  car: (key) => {
    const o = ORG[key];
    return {
      1: `car · 1. POST /api/orders stores the existing car payload (Rental cost $249.99 prepaid + Deposit $100.00 at the counter) and freezes ${o.brandName}'s car terms`,
      2: `car · 2. ${o.gatewayLabel} is asked for exactly the prepaid $249.99 — never the $100.00 deposit or the $349.99 total — under the car's own line item`,
      3:
        o.captureMode === CaptureMode.MANUAL
          ? `car · 3. composer preview + sent payment request: ${o.brandName}'s car terms only, its name and support contact, ${o.gatewayLabel} named — the brand-leak car pins worded for a HOLD ('Card hold today $249.99', 'Authorize $249.99'), never 'You pay today' / 'Amount paid online'`
          : `car · 3. composer preview + sent payment request: ${o.brandName}'s car terms only, its name and support contact, ${o.gatewayLabel} named — byte-identical to the brand-leak car pins`,
      4:
        o.captureMode === CaptureMode.MANUAL
          ? `car · 4. consent page: no other terms, ${o.brandName}'s ${o.gatewayLabel} checkout, the rental summary as a HOLD and 'Confirm & Authorize Card'`
          : `car · 4. consent page: no other terms, ${o.brandName}'s ${o.gatewayLabel} checkout, the rental summary and 'Confirm & Continue to Payment'`,
      5: `car · 5. ${key === "trip" ? "PayPal approve → capture webhooks" : "Stripe authorization (AUTHORIZED email) → capture"} → confirmation with car terms only; CR-7781 saved and resent under 'Confirmation number', shown once`,
      6: `car · 6. order page cards from GET /api/orders/[id]: 'Rental provider', Vehicle / Pick-up / Drop-off, the rental breakdown, 'Confirmation number' CR-7781`,
    };
  },
  flight: (key) => {
    const o = ORG[key];
    return {
      1: `flight · 1. POST /api/orders stores Airline Charge $400.00 apart and ONE charge 'Rental Cost' $100.00 (pricing $100.00, no PNR yet) and freezes ${o.brandName}'s flight terms`,
      2: `flight · 2. ${o.gatewayLabel} is asked for exactly ${key === "trip" ? "'100.00'" : "unit_amount 10000"} — never 400 / 500 anywhere in the request — and its text leads with 'Rental Cost'`,
      3:
        o.captureMode === CaptureMode.MANUAL
          ? `flight · 3. composer preview + sent payment request: ${o.brandName}'s flight terms only, Airline Charge $400.00 / Rental Cost $100.00 / Total Booking Value $500.00 / Rental Cost On Hold $100.00, 'Review & authorize $100.00 Rental Cost', ${o.gatewayLabel} named — never 'Amount Payable Now'`
          : `flight · 3. composer preview + sent payment request: ${o.brandName}'s flight terms only, Airline Charge $400.00 / Rental Cost $100.00 / Total Booking Value $500.00 / Amount Payable Now $100.00, 'Review & pay $100.00 Rental Cost', ${o.gatewayLabel} named`,
      4:
        o.captureMode === CaptureMode.MANUAL
          ? `flight · 4. consent page: no other terms, the four rows ending 'Rental Cost On Hold', 'Confirm & authorize $100.00 Rental Cost', ${o.gatewayLabel} checkout`
          : `flight · 4. consent page: no other terms, the four rows, 'Confirm & pay $100.00 Rental Cost', ${o.gatewayLabel} checkout`,
      5: `flight · 5. ${key === "trip" ? "PayPal approve → capture webhooks" : "Stripe authorization (AUTHORIZED email: 'Rental Cost On Hold') → capture"} → confirmation with flight terms only; AXXXYY saved and resent under 'PNR' in the top block, ONCE (no PNR row)`,
      6: `flight · 6. order page cards from GET /api/orders/[id]: 'Airline / Supplier', the itinerary, the flight rows (no PNR row), 'PNR' AXXXYY`,
    };
  },
  hotel: (key) => {
    const o = ORG[key];
    return {
      1: `hotel · 1. POST /api/orders stores Room charge $300.00 prepaid + Resort fee $50.00 at the property, check-in / check-out as calendar days, and freezes ${o.brandName}'s hotel terms`,
      2:
        key === "trip"
          ? "hotel · 2. PayPal is asked for exactly '300.00' — never the $50.00 balance or $350.00 — described as the 'Prepayment' of the stay at Harbour View Hotel, never by the supplier's key"
          : "hotel · 2. Stripe is asked for exactly unit_amount 30000 — never the $50.00 balance or $350.00 — the line item names the supplier 'Harbour Stays' (never its key), the description says 'Prepayment'",
      3:
        o.captureMode === CaptureMode.MANUAL
          ? `hotel · 3. composer preview + sent payment request: ${o.brandName}'s hotel terms only, the stay rows, 'Card hold today' / 'Amount due at the property' / 'Total hotel cost', no car words, ${o.gatewayLabel} named`
          : `hotel · 3. composer preview + sent payment request: ${o.brandName}'s hotel terms only, the stay rows, 'Amount payable now' / 'Amount due at the property' / 'Total hotel cost', no car words, ${o.gatewayLabel} named`,
      4:
        o.captureMode === CaptureMode.MANUAL
          ? `hotel · 4. consent page: no other terms, the stay rows (calendar days, room preference), the property balance, the HOLD and 'Confirm & Authorize Card', ${o.gatewayLabel} checkout`
          : `hotel · 4. consent page: no other terms, the stay rows (calendar days, room preference), the property balance, ${o.gatewayLabel} checkout`,
      5: `hotel · 5. ${key === "trip" ? "PayPal approve → capture webhooks" : "Stripe authorization (AUTHORIZED email) → capture"} → confirmation with hotel terms only; HC-55120 saved and resent under 'Hotel confirmation number', shown once`,
      6: `hotel · 6. order page cards from GET /api/orders/[id]: 'Hotel / Supplier', the stay rows, room preference and guest notes, the property breakdown, 'Hotel confirmation number' HC-55120`,
    };
  },
};

for (const key of ORG_KEYS) {
  const org = ORG[key];
  const foe: OrgKey = key === "trip" ? "other" : "trip";
  const isPayPal = org.gateway === PaymentGatewayKey.PAYPAL;
  // A MANUAL brand's checkout only AUTHORIZES the card: every surface before
  // the capture names a hold, never a payment taken now.
  const hold = org.captureMode === CaptureMode.MANUAL;

  describe(ORG_TITLE[key], () => {
    for (const kind of KINDS) {
      const spec = KIND[kind];
      const title = TITLES[kind](key);

      /* ---------------------------------------------------------- 1 */
      it(title[1], async () => {
        const { created, stored } = await startJourney(key, kind);

        expect(created.serviceType).toBe(SERVICE_OF[kind]);
        expect(String(stored.organizationId)).toBe(String(orgIds[key]));
        expect(created.provider.name).toBe(spec.supplier);
        // The text this brand saved for THIS service, frozen on the order.
        expect(stored.terms.text).toBe(`${org.terms[kind]} — clause one of these terms.`);
        expect(stored.policy.text).toBe(`${org.policies[kind]} — rule one of this policy.`);
        expect(created.terms.text).toBe(stored.terms.text);
        expect(created.confirmationNumber).toBeNull();

        switch (kind) {
          case "car":
            expect(stored.charges).toEqual([
              { name: "Rental cost", amount: 249.99, timing: PaymentTiming.PREPAID },
              { name: "Deposit", amount: 100, timing: PaymentTiming.DUE_AT_COUNTER },
            ]);
            expect(stored.pricing).toEqual({ amount: 249.99, currency: "USD" });
            break;
          case "flight":
            expect(stored.charges).toEqual([
              { name: FLIGHT_CHARGE, amount: 100, timing: PaymentTiming.PREPAID },
            ]);
            expect(stored.flight!.airlineFare).toBe(400);
            expect(stored.flight!.pnr ?? null).toBeNull();
            // pricing.amount is what the link collects: the charge alone.
            expect(stored.pricing).toEqual({ amount: 100, currency: "USD" });
            break;
          case "hotel":
            expect(stored.charges).toEqual([
              { name: "Room charge", amount: 300, timing: PaymentTiming.PREPAID },
              { name: "Resort fee", amount: 50, timing: PaymentTiming.DUE_AT_COUNTER },
            ]);
            expect(stored.pricing).toEqual({ amount: 300, currency: "USD" });
            // Calendar days: the posted day at UTC midnight, no clock time.
            expect(new Date(stored.hotel!.checkInDate).toISOString()).toBe(`${CHECK_IN}T00:00:00.000Z`);
            expect(new Date(stored.hotel!.checkOutDate).toISOString()).toBe(`${CHECK_OUT}T00:00:00.000Z`);
            expect(stored.hotel!.roomPreference).toBe(ROOM_PREFERENCE);
            expect(stored.hotel!.guestNotes).toBe(GUEST_NOTES);
            break;
        }
      });

      /* ---------------------------------------------------------- 2 */
      it(title[2], async () => {
        const { created, link } = await startJourney(key, kind);
        expect(link.order.payment.gateway).toBe(org.gateway);
        expect(link.order.pricing.amount).toBe(spec.collected);

        /** The text the gateway shows beside the amount (PayPal's purchase
         *  description, Stripe's line-item description). */
        const expectDescription = (description: string) => {
          switch (kind) {
            case "car":
              // Unchanged: the historic pick-up / drop-off line.
              expect(description).toMatch(
                /^Pick-up: \d{4}-\d{2}-\d{2} \(LAX Airport — Terminal 1\) • Drop-off: \d{4}-\d{2}-\d{2} \(San Diego Downtown\)$/,
              );
              break;
            case "flight":
              // Led by the charge's name, so it never reads as the fare.
              expect(description).toBe(`${FLIGHT_CHARGE} • ${DEPARTS}`);
              break;
            case "hotel":
              // Led by "Prepayment" (a balance is left at the property), so
              // the gateway's cut can never drop it; then the stay and its
              // calendar days — never the supplier's key.
              expect(description.startsWith(`Prepayment • ${PROPERTY} • ${DESTINATION} • `), description).toBe(true);
              expect(description.endsWith(`Check-in: ${CHECK_IN} • Check-out: ${CHECK_OUT} • 3 nights`), description).toBe(true);
              expect(description).not.toContain(HOTEL_SUPPLIER_KEY);
              break;
          }
        };

        if (isPayPal) {
          // PayPal, never Stripe — whatever the composer posted.
          expect(link.stripe).toHaveLength(0);
          expect(link.paypal).toHaveLength(1);
          const body = link.paypal[0]!;
          expect(body.purchase_units).toHaveLength(1);
          const unit = body.purchase_units[0]!;
          const value = spec.collected.toFixed(2);
          expect(unit.amount).toEqual({ currency_code: "USD", value });
          // The only money anywhere in the request.
          expect(amountsIn(body)).toEqual([{ currency_code: "USD", value }]);
          const sent = JSON.stringify(body);
          for (const figure of spec.neverCharged) {
            expect(sent, `PayPal was sent ${figure}`).not.toContain(figure);
          }
          expect(unit.custom_id).toBe(created.id);
          expectDescription(unit.description);
          // PayPal's approval page names the merchant: this brand.
          expect(body.payment_source.paypal.experience_context.brand_name).toBe(org.brandName);
          if (kind === "flight") {
            expect(unit.description.split(" • ")[0]).toBe(FLIGHT_CHARGE);
            expect(sent).not.toContain("Airline Charge");
          }
          if (kind === "hotel") {
            // PayPal receives no line-item name — only the description above,
            // which names the stay and says it is the prepayment; the
            // supplier's catalog key never reaches it, anywhere.
            expect(sent).not.toContain(HOTEL_SUPPLIER_KEY);
          }
        } else {
          expect(link.paypal).toHaveLength(0);
          expect(link.stripe).toHaveLength(1);
          const params = link.stripe[0]!;
          const items = params.line_items ?? [];
          expect(items).toHaveLength(1);
          const item = items[0]!;
          const minor = Math.round(spec.collected * 100);
          expect(item.quantity).toBe(1);
          expect(item.price_data!.unit_amount).toBe(minor);
          expect(item.price_data!.currency).toBe("usd");
          // The only money anywhere in the request.
          expect(amountsIn(params)).toEqual([minor]);
          const sent = JSON.stringify(params);
          for (const figure of spec.neverCharged) {
            expect(sent, `Stripe was sent ${figure}`).not.toContain(figure);
          }
          for (const figure of spec.neverChargedMinor) {
            expect(JSON.stringify(items), `Stripe's line item carries ${figure}`).not.toContain(figure);
          }
          // Manual capture: an authorization, captured later by the operator.
          expect(params.payment_intent_data?.capture_method).toBe("manual");
          expect(params.metadata?.appName).toBe(org.brandName);
          expect(params.payment_intent_data?.description).toBe(`${org.brandName} • ${created.orderNumber}`);
          const product = item.price_data!.product_data!;
          expectDescription(product.description!);
          const expectedName = {
            car: `${CAR_SUPPLIER} • Toyota Camry rental`,
            flight: `${FLIGHT_CHARGE} • ${AIRLINE} • ${ROUTE}`,
            hotel: `${HOTEL_SUPPLIER} • ${PROPERTY} • ${DESTINATION} hotel`,
          }[kind];
          expect(product.name).toBe(expectedName);
          if (kind === "flight") {
            expect(product.name.split(" • ")[0]).toBe(FLIGHT_CHARGE);
            expect(JSON.stringify(items)).not.toContain("Airline Charge");
          }
          if (kind === "hotel") expect(sent).not.toContain(HOTEL_SUPPLIER_KEY);
        }
      });

      /* ---------------------------------------------------------- 3 */
      it(title[3], async () => {
        const consented = await throughConsent(await startJourney(key, kind));
        const { created, preview, request, previewAfterConsent, due } = consented;
        const on = created.orderNumber;
        const mailto = consentMailto(request.email.html);

        // Own service's terms ONLY — preview and the email as sent, every part.
        expectOwnTermsOnly(
          key,
          kind,
          {
            "composer preview": preview,
            "payment request (html)": request.email.html,
            "payment request (text)": request.email.text,
          },
          "terms+policy",
        );
        expectOwnTermsOnly(key, kind, { "consent mailto": mailto }, "none");

        // The brand and its contacts; the processor it really uses.
        expectEmailBrand(key, "payment request", request.email);
        for (const [where, html] of Object.entries({ preview, previewAfterConsent })) {
          expect(visibleText(html), where).toContain(org.brandName);
          expect(html, where).toContain(`mailto:${org.supportEmail}`);
          expect(html, where).toContain(`tel:${org.supportPhone}`);
        }
        expect(mailto.startsWith(`mailto:${org.supportEmail}?`)).toBe(true);
        expect(mailto).toContain(`Hi ${org.brandName} team,`);
        for (const html of [preview, request.email.html]) {
          expect(visibleText(html)).toContain(
            hold
              ? `Card authorized securely via ${org.gatewayLabel} — a hold, not a charge. Your card details are encrypted end-to-end`
              : `Payment processed securely via ${org.gatewayLabel}. Your card details are encrypted end-to-end`,
          );
          expect(visibleText(html)).toContain(`Powered by ${org.gatewayLabel}.`);
        }
        expectOnlyGateway(key, {
          "composer preview": preview,
          "composer preview after consent": previewAfterConsent,
          "payment request (html)": request.email.html,
          "payment request (text)": request.email.text,
          "consent mailto": mailto,
        });

        const read = visibleText(request.email.html);
        const parts = {
          "composer preview": preview,
          "payment request (html)": request.email.html,
          "payment request (text)": request.email.text,
          "consent mailto": mailto,
        };
        switch (kind) {
          case "car": {
            // brand-leak.test.ts' car pins, verbatim — the real send adds only
            // its link's "Due …" line after the order number. A MANUAL brand's
            // email is the same email, every money line worded for the HOLD.
            expect(request.email.subject).toBe(`Complete your Budget payment • ${on}`);
            const rows = hold
              ? "What you'll be charged Rental cost $249.99 Deposit (due at counter) $100.00 " +
                "Card hold today $249.99 Amount due at counter $100.00 Total rental cost $349.99"
              : "What you're paying Rental cost $249.99 Deposit (due at counter) $100.00 " +
                "Amount paid online $249.99 Amount due at counter $100.00 Total rental cost $349.99";
            for (const html of [preview, request.email.html]) {
              expect(visibleText(html)).toContain(rows);
              expect(visibleText(html)).toContain(
                hold
                  ? `Card hold today $249.99 A hold on your card, not a charge — we charge it only once your rental is confirmed with Budget. Order ${on} Due ${due} Review & Confirm Booking`
                  : `You pay today $249.99 Order ${on} Due ${due} Review & Confirm Booking`,
              );
              expect(visibleText(html)).toContain(
                `Booking details Type New booking Provider Budget Vehicle Toyota • Camry ` +
                  `Pick-up ${formatEmailDay(created.trip!.pickupDate)} · LAX Airport — Terminal 1 ` +
                  `Drop-off ${formatEmailDay(created.trip!.dropoffDate)} · San Diego Downtown ${rows}`,
              );
            }
            expect(read).toContain(
              hold
                ? `Hi Ada Lovelace, Thanks for booking with Budget. Your new booking is reserved — please authorize your card using the secure link below to confirm it. You won't be charged until your rental is confirmed.`
                : `Hi Ada Lovelace, Thanks for booking with Budget. Your new booking is reserved — please complete payment using the secure link below to confirm it.`,
            );
            // Once consented: the pay button names the brand's processor.
            expect(visibleText(previewAfterConsent)).toContain(
              `Order ${on} Due ${due} ${hold ? "Authorize" : "Pay"} $249.99 securely with ${org.gatewayLabel} → ` +
                `You already confirmed this booking — this opens ${org.gatewayLabel} Checkout.`,
            );
            if (hold) {
              for (const [where, content] of Object.entries({ ...parts, "composer preview after consent": previewAfterConsent })) {
                expect(everything(content), where).not.toMatch(/You pay today|Amount paid online|What you're paying|Pay \$249\.99/);
              }
            }
            expectNoWords(NOT_CAR_WORDS, parts, false);
            break;
          }
          case "flight": {
            // What the link takes: payable now — or, on MANUAL, held.
            const settled = hold ? `${FLIGHT_CHARGE} On Hold` : "Amount Payable Now";
            const rows = `Price breakdown ${emailMoney(FLIGHT_CHARGE, settled)}`;
            expect(moneyBlock(preview), "composer preview").toBe(rows);
            expect(moneyBlock(request.email.html), "payment request as sent").toBe(rows);
            expect(moneyBlock(previewAfterConsent), "preview after consent").toBe(rows);
            expect(plainText(request.email.text)).toContain(emailMoney(FLIGHT_CHARGE, settled));
            // The subject and the button name the charge — never the airline.
            expect(request.email.subject).toBe(`Complete your ${FLIGHT_CHARGE} payment • ${on}`);
            for (const html of [preview, request.email.html]) {
              expect(visibleText(html)).toContain(
                hold
                  ? `${FLIGHT_CHARGE} On Hold $100.00 ${FLIGHT_CHARGE} A hold on your card, not a charge — we charge it only once your flight is confirmed with ${AIRLINE}. Order ${on} Due ${due} Review & authorize $100.00 ${FLIGHT_CHARGE}`
                  : `Amount Payable Now $100.00 ${FLIGHT_CHARGE} Order ${on} Due ${due} Review & pay $100.00 ${FLIGHT_CHARGE}`,
              );
              expect(visibleText(html)).toContain(
                `Booking details Type New booking Airline / Supplier ${AIRLINE} ${FLIGHT_ROWS} Flight itinerary`,
              );
            }
            expect(read).toContain(
              hold
                ? `Thanks for booking with ${AIRLINE}. Your new booking is reserved — please authorize the ${FLIGHT_CHARGE} using the secure link below to confirm it. You won't be charged until your flight is confirmed.`
                : `Thanks for booking with ${AIRLINE}. Your new booking is reserved — please pay the ${FLIGHT_CHARGE} using the secure link below to confirm it.`,
            );
            expect(visibleText(previewAfterConsent)).toContain(
              `${hold ? "Authorize" : "Pay"} the $100.00 ${FLIGHT_CHARGE} securely with ${org.gatewayLabel} →`,
            );
            // The "Confirm by email" fallback lists the same four rows.
            expect(mailto).toContain(
              [
                "Airline Charge: 400.00 USD (not collected through this payment link)",
                `${FLIGHT_CHARGE}: 100.00 USD`,
                "Total Booking Value: 500.00 USD",
                `${settled}: 100.00 USD`,
              ].join("\n"),
            );
            expect(read).not.toContain("Amount Payable Now $400.00");
            expect(read).not.toContain("Amount Payable Now $500.00");
            if (hold) {
              for (const [where, content] of Object.entries({ ...parts, "composer preview after consent": previewAfterConsent })) {
                expect(everything(content), where).not.toMatch(/Amount Payable Now|Review & pay|Pay the \$100\.00/);
              }
            }
            expectNoWords(FLIGHT_FORBIDDEN_CAR_WORDS, parts);
            break;
          }
          case "hotel": {
            expect(request.email.subject).toBe(`Complete your ${HOTEL_SUPPLIER} payment • ${on}`);
            const money = hold
              ? "What you'll be charged Room charge $300.00 Resort fee (due at the property) $50.00 " +
                "Card hold today $300.00 Amount due at the property $50.00 Total hotel cost $350.00"
              : "What you're paying Room charge $300.00 Resort fee (due at the property) $50.00 " +
                "Amount payable now $300.00 Amount due at the property $50.00 Total hotel cost $350.00";
            for (const html of [preview, request.email.html]) {
              // The stay: property, destination, the two calendar days (no
              // clock time), rooms, guests, the room preference — then the
              // stay's money, worded for a payment not yet made.
              expect(visibleText(html)).toContain(
                `Booking details Type New booking Hotel / Supplier ${HOTEL_SUPPLIER} ${STAY_ROWS} ${money}`,
              );
              expect(visibleText(html)).toContain(
                hold
                  ? `Card hold today $300.00 A hold on your card, not a charge — we charge it only once your hotel is confirmed with ${HOTEL_SUPPLIER}. Order ${on} Due ${due} Review & Confirm Booking`
                  : `You pay today $300.00 Order ${on} Due ${due} Review & Confirm Booking`,
              );
            }
            expect(plainText(request.email.text)).toContain(
              hold
                ? "Room charge $300.00 Resort fee (due at the property) $50.00 Card hold today $300.00 " +
                    "Amount due at the property $50.00 Total hotel cost $350.00"
                : "Room charge $300.00 Resort fee (due at the property) $50.00 Amount payable now $300.00 " +
                    "Amount due at the property $50.00 Total hotel cost $350.00",
            );
            expect(mailto).toContain(
              [
                `Hotel / Supplier: ${HOTEL_SUPPLIER}`,
                `Property: ${PROPERTY}`,
                `Destination: ${DESTINATION}`,
                "Check-in: 12 Nov 2026",
                "Check-out: 15 Nov 2026",
                "Rooms: 1 room",
                "Guests: 2 adults",
                `Room preference: ${ROOM_PREFERENCE}`,
                "Amount: 300.00 USD",
              ].join("\n"),
            );
            expect(visibleText(previewAfterConsent)).toContain(
              `${hold ? "Authorize" : "Pay"} $300.00 securely with ${org.gatewayLabel} →`,
            );
            if (hold) {
              for (const [where, content] of Object.entries({ ...parts, "composer preview after consent": previewAfterConsent })) {
                expect(everything(content), where).not.toMatch(/You pay today|Amount payable now|What you're paying|Pay \$300\.00/);
              }
            }
            // Nothing is paid yet, so never "Amount paid online"; and no car.
            for (const [where, content] of Object.entries(parts)) {
              expect(everything(content), where).not.toContain("Amount paid online");
              expect(everything(content), `${where} carries the operator's guest notes`).not.toContain(
                GUEST_NOTES,
              );
            }
            expectNoWords(CAR_WORDS, parts);
            break;
          }
        }
      });

      /* ---------------------------------------------------------- 4 */
      it(title[4], async () => {
        const { consent, created } = await throughConsent(await startJourney(key, kind));
        const page = visibleText(consent);

        // The page prints no T&C — and none of another service's or brand's.
        expectOwnTermsOnly(key, kind, { "consent page": consent }, "none");
        expect(page).toContain(
          `you'll continue to ${org.brandName}'s secure ${org.gatewayLabel} checkout.`,
        );
        expect(page).toContain(
          hold
            ? `You'll be taken directly to ${org.gatewayLabel} Checkout to authorize your card. This places a hold, not a charge — the amount is collected only once your booking is confirmed.`
            : `You'll be taken directly to ${org.gatewayLabel} Checkout to complete payment.`,
        );
        expect(page).toContain(`Email ${org.supportEmail} if you need help.`);
        expectOnlyGateway(key, { "consent page": consent });

        switch (kind) {
          case "car":
            expect(page).toContain(
              (hold
                ? "Booking summary Card hold today $249.99 New booking Card hold today $249.99 "
                : "Booking summary You are paying today $249.99 New booking Paid online today $249.99 ") +
                "Remaining balance due at rental counter $100.00 Total rental cost $349.99 " +
                `Customer ${created.customer.name} Email ${created.customer.email} Provider Budget Vehicle Toyota • Camry Pick-up`,
            );
            expect(page).toContain(hold ? "Confirm & Authorize Card" : "Confirm & Continue to Payment");
            if (hold) expect(page).not.toMatch(/paying today|Paid online today|Continue to Payment|complete payment/);
            break;
          case "flight": {
            const settled = hold ? `${FLIGHT_CHARGE} On Hold` : "Amount Payable Now";
            expect(moneyBlock(consent, "Booking summary")).toBe(
              `Booking summary ${settled} $100.00 ${FLIGHT_CHARGE} New booking ${pageMoney(FLIGHT_CHARGE, settled)}`,
            );
            expect(page).toContain(
              `Customer ${created.customer.name} Email ${created.customer.email} Airline / Supplier ${AIRLINE} ${FLIGHT_ROWS} Itinerary`,
            );
            expect(page).toContain(`Confirm & ${hold ? "authorize" : "pay"} $100.00 ${FLIGHT_CHARGE}`);
            expect(page).not.toContain("Confirm & Continue to Payment");
            if (hold) expect(page).not.toMatch(/Amount Payable Now|Confirm & pay|complete payment/);
            expectNoWords(FLIGHT_FORBIDDEN_CAR_WORDS, { "consent page": consent });
            break;
          }
          case "hotel":
            expect(page).toContain(
              hold
                ? "Booking summary Card hold today $300.00 New booking Card hold today $300.00 " +
                    "Remaining balance due at the property $50.00 Total hotel cost $350.00"
                : "Booking summary You are paying today $300.00 New booking Paid online today $300.00 " +
                    "Remaining balance due at the property $50.00 Total hotel cost $350.00",
            );
            // The stay frozen into the consent record, as every surface shows it.
            expect(page).toContain(STAY_ROWS);
            expect(page).toContain(hold ? "Confirm & Authorize Card" : "Confirm & Continue to Payment");
            if (hold) expect(page).not.toMatch(/paying today|Paid online today|Continue to Payment|complete payment/);
            expect(page).not.toMatch(/\d{1,2}:\d{2}\s?(AM|PM)/);
            expect(page).not.toContain(GUEST_NOTES);
            expectNoWords(CAR_WORDS, { "consent page": consent });
            break;
        }
      });

      /* ---------------------------------------------------------- 5 */
      it(title[5], async () => {
        const j = await fullJourney(key, kind);
        const on = j.created.orderNumber;

        // The gateway's word, through the brand's own webhook endpoint.
        if (isPayPal) {
          const p = j.paypal!;
          expect(p.approved.status, JSON.stringify(p.approved.body)).toBe(200);
          expect(p.approved.body.data.captured).toBe(true);
          // Approval is not payment: captured on PayPal, nothing settled yet.
          expect(p.capturesAsked).toBe(1);
          expect(p.statusAfterApproval).toBe(OrderStatus.PAYMENT_PENDING);
          expect(p.drainedAfterApproval.sent).toBe(0);
          expect(p.completed.status, JSON.stringify(p.completed.body)).toBe(200);
          expect(p.completed.body.data).toMatchObject({ handled: true, duplicate: false });
          expect(p.drained.sent).toBe(1);
        } else {
          const a = j.authorization!;
          expect(a.delivered.status, JSON.stringify(a.delivered.body)).toBe(200);
          expect(a.delivered.body.data).toMatchObject({ handled: true, duplicate: false });
          // Held, not paid.
          expect(a.afterAuthorization.status).not.toBe(OrderStatus.PAID);
          expect(a.afterAuthorization.payment.capture).toMatchObject({
            status: PaymentCaptureStatus.AUTHORIZED,
            amountAuthorized: spec.collected,
          });
          expect(a.drained.sent).toBe(1);

          // The AUTHORIZED email: own terms only, own brand, Stripe named.
          const held = a.authorized;
          expectOwnTermsOnly(
            key,
            kind,
            { "authorization (html)": held.html, "authorization (text)": held.text },
            "terms+policy",
          );
          expectEmailBrand(key, "authorization", held);
          expectOnlyGateway(key, { "authorization (html)": held.html, "authorization (text)": held.text });
          const heldText = visibleText(held.html);
          expect(heldText).toContain(
            `Authorization held securely by ${org.gatewayLabel} — PCI-DSS Level 1 certified.`,
          );
          expect(held.subject).toBe(`${spec.supplier} card authorized — not yet charged • ${on}`);
          switch (kind) {
            case "flight":
              expect(moneyBlock(held.html), "authorization").toBe(
                `Price breakdown ${emailMoney(FLIGHT_CHARGE, `${FLIGHT_CHARGE} On Hold`)}`,
              );
              expect(heldText).toContain(`${FLIGHT_CHARGE} On Hold $100.00 Held, not charged Order ${on}`);
              expect(heldText).toContain(
                `Your card has been authorized for the $100.00 ${FLIGHT_CHARGE} — this is a hold`,
              );
              expect(plainText(held.text)).toContain(emailMoney(FLIGHT_CHARGE, `${FLIGHT_CHARGE} On Hold`));
              break;
            case "hotel":
              expect(heldText).toContain(
                "What you'll be charged Room charge $300.00 Resort fee (due at the property) $50.00 " +
                  "Amount authorized $300.00 Amount due at the property $50.00 Total hotel cost $350.00",
              );
              expect(heldText).toContain(`We're confirming your hotel with ${HOTEL_SUPPLIER}.`);
              expect(heldText).toContain(STAY_ROWS);
              expectNoWords(CAR_WORDS, { "authorization (html)": held.html, "authorization (text)": held.text });
              break;
            case "car":
              expect(heldText).toContain(
                "What you'll be charged Rental cost $249.99 Deposit (due at counter) $100.00 " +
                  "Amount authorized $249.99 Amount due at counter $100.00 Total rental cost $349.99",
              );
              expect(heldText).toContain(`We're confirming your rental with ${CAR_SUPPLIER}.`);
              break;
          }

          // The operator captures the hold: exactly the authorized amount.
          const c = j.capture!;
          expect(c.captures).toHaveLength(1);
          expect(c.captures[0]!.id).toBe(j.link.order.payment.paymentIntentId);
          expect(c.captures[0]!.params?.amount_to_capture).toBeUndefined();
          expect(c.order.payment.capture).toMatchObject({
            status: PaymentCaptureStatus.CAPTURED,
            amountCaptured: spec.collected,
          });
          expect(c.drained.sent).toBe(1);
        }
        expect(j.paid.status).toBe(OrderStatus.PAID);
        expect(j.paid.payment.amountReceived).toBe(spec.collected);

        // The confirmation the payment sent: own terms only, own brand,
        // the processor that took the money — and no reference yet.
        const confirmation = j.confirmation;
        expectOwnTermsOnly(
          key,
          kind,
          { "confirmation (html)": confirmation.html, "confirmation (text)": confirmation.text },
          "terms+policy",
        );
        expectEmailBrand(key, "confirmation", confirmation);
        expectOnlyGateway(key, { "confirmation (html)": confirmation.html, "confirmation (text)": confirmation.text });
        const conf = visibleText(confirmation.html);
        expect(conf).toContain(`Payment processed securely by ${org.gatewayLabel} — PCI-DSS Level 1 certified.`);
        expect(conf).toContain(`please keep this email for your records. ${spec.supplier} New booking Booking details`);
        expect(conf).not.toContain(spec.referenceLabel);
        expect(confirmation.subject).toBe(`${spec.supplier} booking confirmed • ${on}`);
        switch (kind) {
          case "car":
            expect(conf).toContain(
              "Charge breakdown Rental cost $249.99 Deposit (due at counter) $100.00 " +
                "Amount paid online $249.99 Amount due at counter $100.00 Total rental cost $349.99",
            );
            expect(conf).toContain(`Amount paid $249.99 Order ${on}`);
            break;
          case "flight":
            expect(moneyBlock(confirmation.html), "confirmation").toBe(
              `Price breakdown ${emailMoney(FLIGHT_CHARGE, `${FLIGHT_CHARGE} Paid`)}`,
            );
            expect(conf).toContain(`We've received your ${FLIGHT_CHARGE} payment for new booking`);
            expect(conf).toContain(`${FLIGHT_CHARGE} Paid $100.00 Order ${on}`);
            expect(plainText(confirmation.text)).toContain(emailMoney(FLIGHT_CHARGE, `${FLIGHT_CHARGE} Paid`));
            break;
          case "hotel":
            expect(conf).toContain(
              "Charge breakdown Room charge $300.00 Resort fee (due at the property) $50.00 " +
                "Amount paid online $300.00 Amount due at the property $50.00 Total hotel cost $350.00",
            );
            expect(conf).toContain(STAY_ROWS);
            expect(everything(confirmation.html)).not.toContain(GUEST_NOTES);
            expectNoWords(CAR_WORDS, { "confirmation (html)": confirmation.html, "confirmation (text)": confirmation.text });
            break;
        }

        // The operator saves the booking reference, then resends.
        expect(j.referenceSaved.confirmationNumber).toBe(spec.reference);
        expect(j.resend.emailId).toBeTruthy();
        expect(j.resend.order.confirmationNumber).toBe(spec.reference);
        const resent = j.resend.email;
        expectOwnTermsOnly(
          key,
          kind,
          { "resent confirmation (html)": resent.html, "resent confirmation (text)": resent.text },
          "terms+policy",
        );
        expectEmailBrand(key, "resent confirmation", resent);
        expectOnlyGateway(key, { "resent confirmation (html)": resent.html, "resent confirmation (text)": resent.text });
        const again = visibleText(resent.html);
        // The top block, under the service's own name for it…
        expect(again).toContain(
          `please keep this email for your records. ${spec.referenceLabel} ${spec.reference} ${spec.supplier} New booking Booking details`,
        );
        // …and ONCE: in the HTML and in the plain-text part.
        expect(occurrences(again, spec.reference), "reference in the resent HTML").toBe(1);
        expect(occurrences(resent.text, spec.reference), "reference in the resent text").toBe(1);
        if (kind === "flight") {
          // No second "PNR" row in the booking details.
          expect(again.match(/\bPNR\b/g), "PNR labels in the resent HTML").toHaveLength(1);
          expect(resent.text.match(/\bPNR\b/g), "PNR labels in the resent text").toHaveLength(1);
          expect(again).toContain(`Booking details Type New booking Airline / Supplier ${AIRLINE} ${FLIGHT_ROWS} Flight itinerary`);
        } else {
          expect(again).not.toMatch(/\bPNR\b/);
        }
        if (kind === "hotel") expect(again).not.toContain("Confirmation number");

        // The page its "I Agree" opens prints these terms and no other.
        expectOwnTermsOnly(key, kind, { "acknowledge page": j.acknowledge }, "terms");
        // (The order number is its own <span>, so a space precedes the period.)
        expect(visibleText(j.acknowledge)).toContain(
          `Please review and acknowledge the terms for your ${org.brandName} booking ${on} .`,
        );
        expect(visibleText(j.acknowledge)).toContain(`Email ${org.supportEmail} if you need help.`);

        // The receipt names the reference the same way, once.
        const receipt = visibleText(j.receipt);
        expectOwnTermsOnly(key, kind, { receipt: j.receipt }, "none");
        expect(receipt).toContain(`${spec.receiptLabel} ${spec.reference}`);
        expect(occurrences(receipt, spec.reference)).toBe(1);
        expect(receipt).toContain(`Questions? Reach us at ${org.supportEmail} · ${org.supportPhone}.`);
        expect(receipt).toContain(`Payment processed securely by ${org.gatewayLabel} — PCI-DSS Level 1 certified.`);
        expectOnlyGateway(key, { receipt: j.receipt });
      });

      /* ---------------------------------------------------------- 6 */
      it(title[6], async () => {
        const j = await fullJourney(key, kind);
        const { detail, cards } = j;
        const on = j.created.orderNumber;

        // The order API the page loads.
        expect(detail.status).toBe(OrderStatus.PAID);
        expect(detail.confirmationNumber).toBe(spec.reference);
        expect(detail.terms.text).toBe(`${org.terms[kind]} — clause one of these terms.`);
        expect(detail.policy.text).toBe(`${org.policies[kind]} — rule one of this policy.`);
        if (kind === "flight") expect(detail.flight!.pnr).toBeNull();

        // The booking-reference card: the service's own name, the saved value.
        const reference = visibleText(cards.reference);
        expect(reference.startsWith(`${spec.referenceLabel} ${spec.referenceHelp}`), reference).toBe(true);
        expect(cards.reference).toContain(`value="${spec.reference}"`);
        expect(reference).toContain(
          `If you've added or changed the ${spec.referenceNoun} since, resend it so the customer receives the updated copy.`,
        );
        expect(reference).toContain("Resend confirmation email");

        const details = visibleText(cards.details);
        const payment = visibleText(cards.payment);
        expect(payment).toContain(`Gateway ${org.gatewayLabel}`);
        expect(payment).toContain(`Paid online ${money(spec.collected)} Amount received ${money(spec.collected)}`);
        if (!isPayPal) {
          expect(payment).toContain("Authorization Captured");
          expect(payment).toContain(`Amount authorized ${money(spec.collected)} Capture deadline`);
          expect(payment).toContain(`Amount captured ${money(spec.collected)} Booking (not payment) Confirmed`);
        }
        switch (kind) {
          case "car":
            expect(details).toContain(`${spec.providerLabel} ${CAR_SUPPLIER} Toyota Camry ${on} New booking`);
            expect(details).toContain("Vehicle Toyota Camry Pick-up");
            expect(details).toContain("Drop-off");
            expect(payment).toContain(
              "Charge breakdown Rental cost · prepaid $249.99 Deposit · at counter $100.00 " +
                "Amount paid online $249.99 Amount due at counter $100.00 Total rental cost $349.99",
            );
            expectNoWords(NOT_CAR_WORDS, cards, false);
            break;
          case "flight":
            expect(details).toContain(`${spec.providerLabel} ${AIRLINE} ${ROUTE} ${on} New booking Itinerary`);
            expect(details).toContain(`${FLIGHT_ROWS} Created by`);
            // The reference has its own card — never a row here too.
            expect(details).not.toMatch(/\bPNR\b/);
            expect(details).not.toContain(spec.reference);
            expect(payment).toContain(
              "Charge breakdown Airline Charge $400.00 Not collected through this payment link " +
                `${FLIGHT_CHARGE} $100.00 Total Booking Value $500.00 Collected online $100.00`,
            );
            expectNoWords(FLIGHT_FORBIDDEN_CAR_WORDS, cards);
            break;
          case "hotel":
            expect(details).toContain(
              `${spec.providerLabel} ${HOTEL_SUPPLIER} ${PROPERTY} • ${DESTINATION} ${on} New booking`,
            );
            expect(details).toContain(
              `Property ${PROPERTY} Destination ${DESTINATION} Check-in 12 Nov 2026 Check-out 15 Nov 2026 Rooms 1 room Guests 2 adults Created by`,
            );
            // The operator's page lists the customer's request and its own notes.
            expect(details).toContain(`Room preference ${ROOM_PREFERENCE} Guest notes ${GUEST_NOTES}`);
            expect(details).not.toContain(spec.reference);
            expect(payment).toContain(
              "Charge breakdown Room charge · prepaid $300.00 Resort fee (due at the property) $50.00 " +
                "Amount paid online $300.00 Amount due at the property $50.00 Total hotel cost $350.00",
            );
            expectNoWords(CAR_WORDS, cards);
            break;
        }
        // No other service's or brand's terms on the operator's page either.
        expectOwnTermsOnly(key, kind, cards, "none");
        expectOwnTermsOnly(key, kind, { "order API": JSON.stringify(detail) }, "terms+policy");
      });
    }

    /* ------------------------------------------------------------ 7 */
    it(`7. cross-org: no ${ORG[foe].brandName} terms, policy, name or support contact on any ${org.brandName} email, page, order card or gateway request — every service, both brands' journeys interleaved`, async () => {
      const mine: Finished[] = [];
      for (const kind of KINDS) {
        // The other brand books the same service in the same process first.
        await fullJourney(foe, kind);
        mine.push(await fullJourney(key, kind));
      }
      const foreign = brandMarkers(foe).map((m) => m.toLowerCase());
      for (const j of mine) {
        for (const [where, content] of Object.entries(surfacesOf(j))) {
          const all = everything(content).toLowerCase();
          for (const marker of foreign) {
            expect(all, `${j.kind}: ${where} carries ${ORG[foe].brandName}'s "${marker}"`).not.toContain(
              marker,
            );
          }
        }
        // …and each names its own brand where a customer reads a brand.
        for (const [where, html] of Object.entries({
          "payment request": j.request.email.html,
          "consent page": j.consent,
          confirmation: j.resend.email.html,
          "acknowledge page": j.acknowledge,
          receipt: j.receipt,
        })) {
          expect(visibleText(html), `${j.kind}: ${where}`).toContain(org.brandName);
        }
        // The gateway request went to this brand's processor only.
        expect(j.link[isPayPal ? "stripe" : "paypal"], `${j.kind}: the other processor was asked`).toHaveLength(0);
      }
    }, 120_000);

    /* ------------------------------------------------------------ 8 */
    if (key === "trip") {
      it("8. charge-name change: a second Trip Brand flight named 'Processing Fee' (same Airline Charge $400.00 / $100.00) — its preview and sent email say 'Processing Fee', never 'Rental Cost'; PayPal is asked for the same '100.00'", async () => {
        const rental = await startJourney(key, "flight", FLIGHT_CHARGE);
        const renamed = await startJourney(key, "flight", "Processing Fee");

        expect(renamed.stored.charges).toEqual([
          { name: "Processing Fee", amount: 100, timing: PaymentTiming.PREPAID },
        ]);
        expect(renamed.stored.flight!.airlineFare).toBe(400);
        expect(renamed.stored.pricing).toEqual({ amount: 100, currency: "USD" });

        // PayPal: the same money; only the name in the description changes.
        const bodies = [rental.link.paypal, renamed.link.paypal].map((b) => {
          expect(b).toHaveLength(1);
          return b[0]!;
        });
        for (const body of bodies) {
          expect(body.purchase_units[0]!.amount).toEqual({ currency_code: "USD", value: "100.00" });
          expect(amountsIn(body)).toEqual([{ currency_code: "USD", value: "100.00" }]);
          for (const figure of ["400.00", "500.00"]) {
            expect(JSON.stringify(body)).not.toContain(figure);
          }
        }
        expect(bodies[0]!.purchase_units[0]!.description).toBe(`${FLIGHT_CHARGE} • ${DEPARTS}`);
        expect(bodies[1]!.purchase_units[0]!.description).toBe(`Processing Fee • ${DEPARTS}`);
        expect(getCurrentTestStripe().sessionsCreated).toHaveLength(0);

        // The renamed order's preview and the email actually sent.
        const mailto = consentMailto(renamed.request.email.html);
        const rows = `Price breakdown ${emailMoney("Processing Fee", "Amount Payable Now")}`;
        expect(moneyBlock(renamed.preview), "preview").toBe(rows);
        expect(moneyBlock(renamed.request.email.html), "sent email").toBe(rows);
        expect(plainText(renamed.request.email.text)).toContain(emailMoney("Processing Fee", "Amount Payable Now"));
        expect(renamed.request.email.subject).toBe(
          `Complete your Processing Fee payment • ${renamed.created.orderNumber}`,
        );
        for (const html of [renamed.preview, renamed.request.email.html]) {
          expect(visibleText(html)).toContain("Review & pay $100.00 Processing Fee");
          expect(visibleText(html)).toContain(
            "please pay the Processing Fee using the secure link below to confirm it.",
          );
        }
        expect(mailto).toContain("Processing Fee: 100.00 USD");
        for (const [where, content] of Object.entries({
          preview: renamed.preview,
          "sent email (html)": renamed.request.email.html,
          "sent email (text)": renamed.request.email.text,
          "sent email (subject)": renamed.request.email.subject,
          "consent mailto": mailto,
        })) {
          expect(everything(content).toLowerCase(), `${where} still says "Rental Cost"`).not.toContain(
            "rental cost",
          );
        }
        expectOwnTermsOnly(
          key,
          "flight",
          { preview: renamed.preview, "sent email (html)": renamed.request.email.html },
          "terms+policy",
        );

        // Each order keeps its own name: the first still reads "Rental Cost".
        expect(moneyBlock(await composerPreview(key, rental.created.id))).toBe(
          `Price breakdown ${emailMoney(FLIGHT_CHARGE, "Amount Payable Now")}`,
        );
        expect(rental.request.email.subject).toBe(
          `Complete your ${FLIGHT_CHARGE} payment • ${rental.created.orderNumber}`,
        );
      });
    }
  });
}

