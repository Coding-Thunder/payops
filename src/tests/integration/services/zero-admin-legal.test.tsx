import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Types } from "mongoose";

import { PATCH as legalRoute } from "@/app/api/admin/settings/legal/route";
import { GET as createConfigRoute } from "@/app/api/orders/create-config/route";
import { POST as createOrderRoute } from "@/app/api/orders/route";
import { GET as getOrderRoute } from "@/app/api/orders/[id]/route";
import { POST as generateLinkRoute } from "@/app/api/orders/[id]/generate-payment-link/route";
import { POST as previewRoute } from "@/app/api/orders/[id]/payment-request-preview/route";
import { POST as resendConfirmationRoute } from "@/app/api/orders/[id]/resend-confirmation/route";
import { POST as sendRequestRoute } from "@/app/api/orders/[id]/send-payment-request/route";
import { POST as stripeWebhookRoute } from "@/app/api/webhooks/stripe/[orgSlug]/route";
import AdminSettingsPage from "@/app/app/admin/settings/page";
import CreateOrderPage from "@/app/app/orders/create/page";
import ConsentPage from "@/app/consent/[token]/page";
import type { EmailTemplateKey } from "@/lib/constants/email-templates";
import {
  AuditAction,
  EmailKind,
  OrderStatus,
  PaymentGatewayKey,
  RecordState,
  ServiceType,
  UserRole,
} from "@/lib/constants/enums";
import { logger } from "@/lib/logger";
import { nextPolicyVersion } from "@/lib/policy-version";
import {
  AuditLog,
  Order,
  Organization,
  OrganizationMember,
  Setting,
  SETTINGS_KEY,
} from "@/server/db/models";
import {
  DEFAULT_CANCELLATION_POLICY,
  DEFAULT_FLIGHT_CANCELLATION_POLICY,
  DEFAULT_FLIGHT_LEGAL_VERSION,
  DEFAULT_FLIGHT_TERMS_AND_CONDITIONS,
  DEFAULT_HOTEL_CANCELLATION_POLICY,
  DEFAULT_HOTEL_LEGAL_VERSION,
  DEFAULT_HOTEL_TERMS_AND_CONDITIONS,
  DEFAULT_TERMS_AND_CONDITIONS,
} from "@/server/db/models/setting.model";
import { orgCookieName } from "@/server/auth/org-cookie";
import { renderEmailPreview } from "@/server/email/preview";
import { _setPayPalFetchForTesting } from "@/server/payments/gateways/paypal";
import { resolveServiceTerms } from "@/server/services/organization-legal.service";
import { createProvider } from "@/server/services/provider.service";
import { getSettings } from "@/server/services/settings.service";
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
import type { OrderDTO } from "@/types";

/**
 * ZERO ADMIN DEPENDENCY FOR TERMS & CONDITIONS.
 *
 * Every organization resolves its terms from two inputs only — its id and
 * the order's service type — and NOBODY has to configure anything first:
 *
 *   CAR_RENTAL  the organization's own car text if it customised it, else
 *               the deployment's pre-written car text (Settings, seeded
 *               from the built-in car defaults) — and, were that ever
 *               blank, the built-in DEFAULT_TERMS_AND_CONDITIONS /
 *               DEFAULT_CANCELLATION_POLICY
 *   FLIGHT      its own if customised, else the built-in DEFAULT_FLIGHT_*
 *   HOTEL       its own if customised, else the built-in DEFAULT_HOTEL_*
 *
 * Never another service's text, never another organization's. Customising
 * (Admin → Settings, PATCH /api/admin/settings/legal) is optional and
 * still works; orders already frozen keep their text.
 *
 * Everything here goes through the real route handlers — order creation,
 * link generation (the Stripe stub / a PayPal stub), the composer preview,
 * the payment request as it left through SMTP, the hosted consent page, the
 * brand's own Stripe webhook → outbox → confirmation, the operator's
 * resend, the email previews (`renderEmailPreview`), the create page and
 * create-config, and Admin → Settings — for three organizations:
 *
 *   Fresh Brand        brand-new, Stripe, sells car · flight · hotel, NO
 *                      legal fields at all, nobody ever saves any terms
 *   Own Flight Brand   Stripe, sells all three, customises FLIGHT only
 *   Trip Reservations  PayPal, sells [CAR_RENTAL, FLIGHT] (stored), no
 *                      legal at all — shaped like production
 *
 * Expected texts and versions are derived from the exported constants and
 * from whatever the deployment's Settings holds (`getSettings`), never
 * retyped.
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
 * The deployment
 * ------------------------------------------------------------------ */

type Kind = "car" | "flight" | "hotel";
type OrgKey = "fresh" | "other" | "trip";

const KINDS: Kind[] = ["car", "flight", "hotel"];
const ORG_KEYS: OrgKey[] = ["fresh", "other", "trip"];
const SERVICE_OF: Record<Kind, ServiceType> = {
  car: ServiceType.CAR_RENTAL,
  flight: ServiceType.FLIGHT,
  hotel: ServiceType.HOTEL,
};
const TEMPLATES: EmailTemplateKey[] = [
  "payment-request",
  "payment-confirmation",
  "payment-authorized",
];

interface OrgSpec {
  slug: string;
  brandName: string;
  gateway: PaymentGatewayKey;
  serviceTypes: ServiceType[];
  supportEmail: string;
  fromEmail: string;
  /** Remove `legal` with the raw driver, so the stored document has no legal
   *  fields at all (not even Mongoose's empty defaults). */
  noLegalFields: boolean;
  env: Record<string, string>;
}

const ALL_SERVICES = [ServiceType.CAR_RENTAL, ServiceType.FLIGHT, ServiceType.HOTEL];

const ORG: Record<OrgKey, OrgSpec> = {
  fresh: {
    slug: "freshbrand",
    brandName: "Fresh Brand",
    gateway: PaymentGatewayKey.STRIPE,
    serviceTypes: ALL_SERVICES,
    supportEmail: "support@freshbrand.test",
    fromEmail: "bookings@freshbrand.test",
    noLegalFields: true,
    env: {
      ORG_FRESHBRAND_STRIPE_SECRET_KEY: "sk_test_freshbrand_only",
      ORG_FRESHBRAND_STRIPE_WEBHOOK_SECRET: "whsec_freshbrand_only",
    },
  },
  other: {
    slug: "ownflightbrand",
    brandName: "Own Flight Brand",
    gateway: PaymentGatewayKey.STRIPE,
    serviceTypes: ALL_SERVICES,
    supportEmail: "support@ownflightbrand.test",
    fromEmail: "bookings@ownflightbrand.test",
    // Created the way the app creates one (Mongoose's empty legal block).
    noLegalFields: false,
    env: {
      ORG_OWNFLIGHTBRAND_STRIPE_SECRET_KEY: "sk_test_ownflightbrand_only",
      ORG_OWNFLIGHTBRAND_STRIPE_WEBHOOK_SECRET: "whsec_ownflightbrand_only",
    },
  },
  trip: {
    slug: "tripreservations",
    brandName: "Trip Reservations",
    gateway: PaymentGatewayKey.PAYPAL,
    serviceTypes: [ServiceType.CAR_RENTAL, ServiceType.FLIGHT],
    supportEmail: "contact@tripreservations.test",
    fromEmail: "contact@tripreservations.test",
    noLegalFields: true,
    env: {
      ORG_TRIPRESERVATIONS_PAYPAL_CLIENT_ID: "tripreservations-client-id",
      ORG_TRIPRESERVATIONS_PAYPAL_CLIENT_SECRET: "tripreservations-client-secret",
      ORG_TRIPRESERVATIONS_PAYPAL_WEBHOOK_ID: "WEBHOOK-TRIPRESERVATIONS",
      ORG_TRIPRESERVATIONS_PAYPAL_SANDBOX: "true",
    },
  },
};

const ALL_ENV: Record<string, string> = {
  ...ORG.fresh.env,
  ...ORG.other.env,
  ...ORG.trip.env,
};

/* ------------------------------------------------------------------ *
 * The texts — derived, never retyped
 * ------------------------------------------------------------------ */

interface LegalText {
  terms: string;
  termsVersion: string;
  policy: string;
  policyVersion: string;
}

const BUILT_IN_FLIGHT: LegalText = {
  terms: DEFAULT_FLIGHT_TERMS_AND_CONDITIONS,
  termsVersion: DEFAULT_FLIGHT_LEGAL_VERSION,
  policy: DEFAULT_FLIGHT_CANCELLATION_POLICY,
  policyVersion: DEFAULT_FLIGHT_LEGAL_VERSION,
};

const BUILT_IN_HOTEL: LegalText = {
  terms: DEFAULT_HOTEL_TERMS_AND_CONDITIONS,
  termsVersion: DEFAULT_HOTEL_LEGAL_VERSION,
  policy: DEFAULT_HOTEL_CANCELLATION_POLICY,
  policyVersion: DEFAULT_HOTEL_LEGAL_VERSION,
};

/** The label the built-in car text is seeded with: the Settings schema
 *  pairs DEFAULT_TERMS_AND_CONDITIONS / DEFAULT_CANCELLATION_POLICY with
 *  these version defaults. */
const BUILT_IN_CAR_TERMS_VERSION = String(
  (Setting.schema.path("termsVersion") as unknown as { defaultValue: unknown }).defaultValue,
);
const BUILT_IN_CAR_POLICY_VERSION = String(
  (Setting.schema.path("cancellationPolicyVersion") as unknown as { defaultValue: unknown })
    .defaultValue,
);

/** The deployment's pre-written car text — whatever Settings holds. */
async function deploymentCarText(): Promise<LegalText> {
  const s = await getSettings();
  return {
    terms: s.termsAndConditions,
    termsVersion: s.termsVersion,
    policy: s.cancellationPolicy,
    policyVersion: s.cancellationPolicyVersion,
  };
}

/** What each service's order freezes for a brand that never customised. */
async function preWritten(): Promise<Record<Kind, LegalText>> {
  return { car: await deploymentCarText(), flight: BUILT_IN_FLIGHT, hotel: BUILT_IN_HOTEL };
}

/** Own Flight Brand's FLIGHT override — its only customisation. No
 *  apostrophes (HTML escaping); no marker is a substring of another. */
const OTHER_FLIGHT = {
  terms: "OWN FLIGHT BRAND FLIGHT TERMS — tickets follow the fare rules this brand agreed with each airline.",
  policy: "OWN FLIGHT BRAND FLIGHT POLICY — refunds follow the release rules this brand agreed with each airline.",
};
const OTHER_MARKERS = ["OWN FLIGHT BRAND FLIGHT TERMS", "OWN FLIGHT BRAND FLIGHT POLICY"];

/** Fresh Brand's optional FLIGHT override (tests 11 and 12 only). */
const FRESH_FLIGHT = {
  terms: "FRESH BRAND FLIGHT TERMS — customised wording: tickets follow the operating airline fare rules.",
  policy: "FRESH BRAND FLIGHT POLICY — customised wording: refunds follow the airline release of the fare.",
};
const FRESH_MARKERS = ["FRESH BRAND FLIGHT TERMS", "FRESH BRAND FLIGHT POLICY"];

/** An organization's first text of its own follows the built-in label. */
const FIRST_OWN_FLIGHT_VERSION = nextPolicyVersion(DEFAULT_FLIGHT_LEGAL_VERSION);

/** Words of a car rental a flight or hotel customer must never agree to. */
const CAR_WORDS = ["vehicle", "rental", "pick-up", "drop-off", "counter"];
/** What a flight's terms are about. */
const FLIGHT_NATIVE: Array<[string, RegExp]> = [
  ["airline", /\bairline/i],
  ["itinerary", /\bitinerary\b/i],
  ["passenger", /\bpassengers?\b/i],
  ["fare", /\bfares?\b/i],
  ["baggage", /\bbaggage\b/i],
  ["supplier", /\bsuppliers?\b/i],
  ["PNR", /\bPNR\b/],
];
/** What a hotel stay's terms are about. */
const HOTEL_NATIVE: Array<[string, RegExp]> = [
  ["property", /\bproperty\b/i],
  ["room / rooms", /\brooms?\b/i],
  ["guest / guests", /\bguests?\b/i],
  ["check-in", /\bcheck-in\b/i],
  ["check-out", /\bcheck-out\b/i],
];
const NOT_IN_HOTEL = ["vehicle", "rental", "airline", "flight"];
/** Flight and hotel words a car renter must never agree to. */
const NOT_IN_CAR: Array<[string, RegExp]> = [
  ["airline", /\bairline/i],
  ["flight", /\bflights?\b/i],
  ["passenger", /\bpassengers?\b/i],
  ["itinerary", /\bitinerar/i],
  ["PNR", /\bPNR\b/i],
  ["baggage", /\bbaggage\b/i],
  ["fare", /\bfares?\b/i],
  ["hotel", /\bhotels?\b/i],
  ["property", /\bproperty\b/i],
  ["room", /\brooms?\b/i],
  ["guest", /\bguests?\b/i],
  ["check-in", /\bcheck-in\b/i],
  ["check-out", /\bcheck-out\b/i],
  ["no-show", /\bno-show\b/i],
];

/** Anything that would send an operator off to configure terms. */
const ADMIN_ERRANDS: Array<[string, RegExp]> = [
  ["Admin → Settings", /Admin → Settings/],
  ["Configure", /configure/i],
  ["of its own yet", /of its own yet/i],
];

/* ------------------------------------------------------------------ *
 * Reading what the customer reads
 * ------------------------------------------------------------------ */

/** The text a reader sees: no head, no tags, entities and React's
 *  text-node separators resolved, whitespace collapsed. Also right for an
 *  email's plain-text part (which has no tags to drop). */
function readable(content: string): string {
  return content
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

/** A legal text's clauses — each is one paragraph wherever it is shown. */
function lines(text: string): string[] {
  return text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function linesOf(t: LegalText): string[] {
  return [...lines(t.terms), ...lines(t.policy)];
}

/** Every clause of `others` that is not also (part of) a clause of `own` —
 *  e.g. the flight and hotel policies share their closing line, so it is
 *  foreign to car rental only. */
function foreignTo(own: LegalText, others: LegalText[]): string[] {
  const mine = linesOf(own);
  return others.flatMap(linesOf).filter((l) => !mine.some((m) => m.includes(l)));
}

/** The other two services' pre-written clauses, foreign to `kind`. */
function otherServices(texts: Record<Kind, LegalText>, kind: Kind): string[] {
  return foreignTo(
    texts[kind],
    KINDS.filter((k) => k !== kind).map((k) => texts[k]),
  );
}

/** Shows every clause of `own` (terms AND policy) and none of `foreign`. */
function expectOwnTextOnly(where: string, content: string, own: LegalText, foreign: string[]) {
  const read = readable(content);
  expect(read.length, `${where} is empty`).toBeGreaterThan(0);
  for (const clause of linesOf(own)) {
    expect(read, `${where} must show: "${clause}"`).toContain(clause);
  }
  expectNoneOf(where, content, foreign);
}

function expectNoneOf(where: string, content: string, foreign: string[]) {
  const read = readable(content);
  for (const text of foreign) {
    expect(read, `${where} must NOT show: "${text}"`).not.toContain(text);
  }
}

function expectNotEmpty(where: string, legal: LegalText) {
  for (const [field, value] of Object.entries(legal)) {
    expect(value.trim().length, `${where}: ${field} is empty`).toBeGreaterThan(0);
  }
}

/* ------------------------------------------------------------------ *
 * The organizations, the operator, the gateways
 * ------------------------------------------------------------------ */

const operator = actorFor(UserRole.ADMIN, { name: "Olivia Operator" });

let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;
const orgIds = {} as Record<OrgKey, Types.ObjectId>;
/** Every PayPal API call the stub answered (OAuth excepted), in order. */
let paypalCalls: { url: string; body: unknown }[] = [];
let paypalOrderSeq = 0;

async function makeOrg(key: OrgKey): Promise<Types.ObjectId> {
  const spec = ORG[key];
  const doc = await Organization.create({
    slug: spec.slug,
    name: spec.brandName,
    brandName: spec.brandName,
    isDefault: false,
    payments: { provider: spec.gateway },
    serviceTypes: spec.serviceTypes,
    email: { fromName: spec.brandName, fromEmail: spec.fromEmail, replyTo: "" },
    support: { email: spec.supportEmail, phone: "" },
  });
  const id = doc._id as Types.ObjectId;
  if (spec.noLegalFields) {
    // No legal of any kind (and, for the PayPal brand, no capture mode):
    // exactly a production row nobody ever configured.
    await Organization.collection.updateOne(
      { _id: id },
      {
        $unset: {
          legal: "",
          ...(spec.gateway === PaymentGatewayKey.PAYPAL ? { "payments.captureMode": "" } : {}),
        },
      },
    );
  }
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

/** Minimal PayPal API: OAuth, order creation, webhook verification and
 *  capture — recording every call. */
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
    const id = `PP-ZERO-ADMIN-${paypalOrderSeq}`;
    return json({
      id,
      status: "PAYER_ACTION_REQUIRED",
      links: [{ rel: "payer-action", href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }],
    });
  }) as unknown as typeof fetch);
}

beforeEach(async () => {
  await ensureMongo();
  // The deployment's Settings, as seeded — its car text is the built-in car
  // default. Nobody edits it (or anything else) unless a test says so.
  await createSettings();
  Object.assign(process.env, ALL_ENV);
  sentMail.length = 0;
  stubPayPal();
  for (const key of ORG_KEYS) orgIds[key] = await makeOrg(key);
  await actingAs("fresh");
  // Global suppliers (no organization restriction): an airline and a hotel
  // supplier. Car rental books the seeded Budget.
  for (const s of [
    { key: "AIRINDIA", name: "Air India", serviceType: ServiceType.FLIGHT, logo: "/providers/air-india.png" },
    { key: "HARBOURSTAYS", name: "Harbour Stays", serviceType: ServiceType.HOTEL, logo: "/providers/preview.png" },
  ]) {
    await createProvider(
      {
        key: s.key,
        name: s.name,
        logo: s.logo,
        primaryColor: "#0B3D91",
        onPrimaryColor: "#FFFFFF",
        tagline: "",
        sortOrder: 0,
        serviceTypes: [s.serviceType],
      } as Parameters<typeof createProvider>[0],
      { actor: operator },
    );
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
 * What the operator, the customer and the gateways do — real routes
 * ------------------------------------------------------------------ */

interface SentEmail {
  subject: string;
  html: string;
  text: string;
}

function onlySentSince(mark: number, kind: EmailKind): SentEmail {
  const found = sentMail
    .slice(mark)
    .filter((m) => (m.headers as Record<string, string>)["X-Entity-Kind"] === kind)
    .map((m) => ({ subject: String(m.subject), html: String(m.html), text: String(m.text) }));
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
function orderBody(kind: Kind) {
  switch (kind) {
    case "car":
      return validCreateOrderInput();
    case "flight":
      return oneWayConnectingFlightInput({ provider: "AIRINDIA" }, { airlineFare: 400, pnr: null });
    case "hotel":
      return validHotelOrderInput({ provider: "HARBOURSTAYS" });
  }
}

/** POST /api/orders — the create form's submit; 201 or the test fails. */
async function submitOrder(key: OrgKey, body: unknown): Promise<OrderDTO> {
  await actingAs(key);
  const { order } = await ok<{ order: OrderDTO }>(
    await createOrderRoute(buildRequest("/api/orders", { method: "POST", body })),
    201,
  );
  return order;
}

async function storedOrder(orderId: string) {
  const doc = await Order.findById(orderId).lean<{
    organizationId: Types.ObjectId;
    serviceType: string;
    terms: { text: string; version: string };
    policy: { text: string; version: string };
  } | null>();
  expect(doc, `order ${orderId} was not stored`).toBeTruthy();
  return doc!;
}

/** The frozen snapshot as a LegalText. */
function frozen(doc: Awaited<ReturnType<typeof storedOrder>>): LegalText {
  return {
    terms: doc.terms.text,
    termsVersion: doc.terms.version,
    policy: doc.policy.text,
    policyVersion: doc.policy.version,
  };
}

/** POST /api/orders/[id]/generate-payment-link — as the composer posts it
 *  (it says STRIPE; the brand's own processor wins). */
async function generateLink(key: OrgKey, orderId: string): Promise<OrderDTO> {
  await actingAs(key);
  const { order } = await ok<{ order: OrderDTO }>(
    await generateLinkRoute(
      buildRequest(`/api/orders/${orderId}/generate-payment-link`, {
        method: "POST",
        body: { gateway: PaymentGatewayKey.STRIPE },
      }),
      idParams(orderId),
    ),
  );
  return order;
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

/** Stripe's checkout.session.completed ("paid"), signed with the brand's
 *  own secret, to the brand's own endpoint; then the outbox run that sends
 *  the confirmation. */
async function payWithStripe(key: OrgKey, linked: OrderDTO) {
  const slug = ORG[key].slug;
  anonymous();
  const payload = JSON.stringify(
    buildCheckoutCompleted({
      orderId: linked.id,
      orderNumber: linked.orderNumber,
      sessionId: linked.payment.paymentSessionId!,
      paymentIntentId: linked.payment.paymentIntentId ?? undefined,
      amountTotal: Math.round(linked.pricing.amount * 100),
    }),
  );
  const secret = ORG[key].env[`ORG_${slug.toUpperCase()}_STRIPE_WEBHOOK_SECRET`]!;
  const delivered = await jsonBody<{ ok: boolean; data: Record<string, unknown> }>(
    await stripeWebhookRoute(
      new Request(`http://localhost/api/webhooks/stripe/${slug}`, {
        method: "POST",
        headers: new Headers({
          "content-type": "application/json",
          "stripe-signature": signWebhook(payload, secret),
        }),
        body: payload,
      }) as never,
      { params: Promise.resolve({ orgSlug: slug }) },
    ),
  );
  const mark = sentMail.length;
  const drained = await drainPendingEmails(10);
  return {
    delivered,
    drained,
    confirmation: onlySentSince(mark, EmailKind.PAYMENT_CONFIRMATION),
  };
}

/** POST /api/orders/[id]/resend-confirmation — the order card's resend. */
async function resendConfirmation(key: OrgKey, orderId: string): Promise<SentEmail> {
  await actingAs(key);
  const mark = sentMail.length;
  await ok(
    await resendConfirmationRoute(
      buildRequest(`/api/orders/${orderId}/resend-confirmation`, { method: "POST", body: {} }),
      idParams(orderId),
    ),
  );
  return onlySentSince(mark, EmailKind.PAYMENT_CONFIRMATION);
}

/** GET /api/orders/[id] — what the operator's order page loads. */
async function orderApi(key: OrgKey, orderId: string): Promise<OrderDTO> {
  await actingAs(key);
  return ok<OrderDTO>(await getOrderRoute(buildRequest(`/api/orders/${orderId}`), idParams(orderId)));
}

/** Admin → Settings, working in `key`'s brand: save its own text for one
 *  service (PATCH /api/admin/settings/legal). */
async function saveOwnLegal(key: OrgKey, kind: Kind, terms: string, policy: string) {
  await actingAs(key);
  return ok<{
    termsAndConditions: string;
    termsVersion: string;
    cancellationPolicy: string;
    cancellationPolicyVersion: string;
    termsIsDefault: boolean;
    policyIsDefault: boolean;
  }>(
    await legalRoute(
      buildRequest("/api/admin/settings/legal", {
        method: "PATCH",
        body: { serviceType: SERVICE_OF[kind], termsAndConditions: terms, cancellationPolicy: policy },
      }),
    ),
  );
}

/** The forms' catalog pickers read through React Query. */
function withQueryClient(ui: ReactElement): ReactElement {
  return createElement(QueryClientProvider, { client: new QueryClient() }, ui);
}

/* ------------------------------------------------------------------ *
 * 1–12 · A brand-new organization, zero legal configuration
 * ------------------------------------------------------------------ */

describe("a BRAND-NEW organization with ZERO legal configuration sells car, flight and hotel — nothing to set up", () => {
  const CREATE_TITLES: Record<Kind, string> = {
    car: "1. car: POST /api/orders answers 201 — no legal fields on the organization, nobody ever saved terms or settings",
    flight: "2. flight: POST /api/orders answers 201 — no legal fields on the organization, nobody ever saved terms or settings",
    hotel: "3. hotel: POST /api/orders answers 201 — no legal fields on the organization, nobody ever saved terms or settings",
  };

  for (const kind of KINDS) {
    it(CREATE_TITLES[kind], async () => {
      // The world: the organization stores no legal fields at all, and no
      // terms or settings were ever saved by anyone.
      const raw = await Organization.collection.findOne({ _id: orgIds.fresh });
      expect(raw).toBeTruthy();
      expect(raw!).not.toHaveProperty("legal");
      expect(raw!.serviceTypes).toEqual(ALL_SERVICES);
      expect(
        await AuditLog.countDocuments({
          action: { $in: [AuditAction.ORGANIZATION_LEGAL_UPDATED, AuditAction.SETTINGS_UPDATED] },
        }),
      ).toBe(0);

      const warn = vi.spyOn(logger, "warn");
      const order = await submitOrder("fresh", orderBody(kind));
      expect(order.serviceType).toBe(SERVICE_OF[kind]);
      const stored = await storedOrder(order.id);
      expect(String(stored.organizationId)).toBe(String(orgIds.fresh));
      expect(stored.serviceType).toBe(SERVICE_OF[kind]);
      expect(await Order.countDocuments({})).toBe(1);
      // Pre-written terms are the normal path: nothing is logged as if a
      // brand had failed to configure them (no `legal.*.default_used`).
      expect(warn.mock.calls.filter(([message]) => /^legal\./.test(String(message)))).toEqual([]);
    });
  }

  it("4. car: the order freezes the deployment's pre-written car terms AND policy — exactly what Settings holds, at its versions, never empty, no flight or hotel words", async () => {
    const settings = await getSettings();
    const order = await submitOrder("fresh", orderBody("car"));
    const stored = await storedOrder(order.id);

    expect(stored.terms).toEqual({ text: settings.termsAndConditions, version: settings.termsVersion });
    expect(stored.policy).toMatchObject({
      text: settings.cancellationPolicy,
      version: settings.cancellationPolicyVersion,
    });
    expectNotEmpty("car snapshot", frozen(stored));
    // The order API behind the operator's order page carries the same.
    const detail = await orderApi("fresh", order.id);
    expect(detail.terms).toEqual(stored.terms);
    expect(detail.policy).toMatchObject({ text: stored.policy.text, version: stored.policy.version });

    const all = `${stored.terms.text}\n${stored.policy.text}`;
    for (const [word, re] of NOT_IN_CAR) {
      expect(all, `the car text says "${word}"`).not.toMatch(re);
    }
  });

  it("5. flight: the order freezes the built-in flight terms AND policy at DEFAULT_FLIGHT_LEGAL_VERSION — airline, itinerary, passenger, fare, baggage, supplier, PNR; no car words", async () => {
    const order = await submitOrder("fresh", orderBody("flight"));
    const stored = await storedOrder(order.id);

    expect(stored.terms).toEqual({
      text: DEFAULT_FLIGHT_TERMS_AND_CONDITIONS,
      version: DEFAULT_FLIGHT_LEGAL_VERSION,
    });
    expect(stored.policy).toMatchObject({
      text: DEFAULT_FLIGHT_CANCELLATION_POLICY,
      version: DEFAULT_FLIGHT_LEGAL_VERSION,
    });
    expectNotEmpty("flight snapshot", frozen(stored));
    const detail = await orderApi("fresh", order.id);
    expect(detail.terms).toEqual(stored.terms);

    const all = `${stored.terms.text}\n${stored.policy.text}`;
    for (const [word, re] of FLIGHT_NATIVE) {
      expect(all, `the flight text never mentions "${word}"`).toMatch(re);
    }
    for (const word of CAR_WORDS) {
      expect(all.toLowerCase(), `the flight text says "${word}"`).not.toContain(word);
    }
  });

  it("6. hotel: the order freezes the built-in hotel terms AND policy at DEFAULT_HOTEL_LEGAL_VERSION — property, rooms, guests, check-in, check-out, no-show; no car or flight words", async () => {
    const order = await submitOrder("fresh", orderBody("hotel"));
    const stored = await storedOrder(order.id);

    expect(stored.terms).toEqual({
      text: DEFAULT_HOTEL_TERMS_AND_CONDITIONS,
      version: DEFAULT_HOTEL_LEGAL_VERSION,
    });
    expect(stored.policy).toMatchObject({
      text: DEFAULT_HOTEL_CANCELLATION_POLICY,
      version: DEFAULT_HOTEL_LEGAL_VERSION,
    });
    expectNotEmpty("hotel snapshot", frozen(stored));
    const detail = await orderApi("fresh", order.id);
    expect(detail.terms).toEqual(stored.terms);

    const all = `${stored.terms.text}\n${stored.policy.text}`;
    for (const [word, re] of HOTEL_NATIVE) {
      expect(all, `the hotel text never mentions "${word}"`).toMatch(re);
    }
    expect(stored.policy.text, "the hotel policy never mentions a no-show").toMatch(/\bno-show\b/i);
    for (const word of NOT_IN_HOTEL) {
      expect(all.toLowerCase(), `the hotel text says "${word}"`).not.toContain(word);
    }
  });

  it("7. no cross-service fallback: each order's frozen snapshot, order API, composer preview, sent payment request (HTML and text) and consent page carry its own service's text and none of the other two services'", async () => {
    const texts = await preWritten();
    for (const kind of KINDS) {
      const created = await submitOrder("fresh", orderBody(kind));
      const stored = await storedOrder(created.id);
      await generateLink("fresh", created.id);
      const preview = await composerPreview("fresh", created.id);
      const { email, consentToken } = await sendRequest("fresh", created.id);
      const detail = await orderApi("fresh", created.id);
      const foreign = otherServices(texts, kind);
      expect(foreign.length, `${kind}: no foreign clauses to look for`).toBeGreaterThan(0);

      // The frozen snapshot IS its own service's text — and no other's.
      expect(frozen(stored)).toEqual(texts[kind]);
      expectNoneOf(`${kind} frozen terms`, stored.terms.text, foreign);
      expectNoneOf(`${kind} frozen policy`, stored.policy.text, foreign);
      expect({ terms: detail.terms.text, policy: detail.policy.text }).toEqual({
        terms: texts[kind].terms,
        policy: texts[kind].policy,
      });

      // Every rendered email surface shows it in full, and nothing else's.
      for (const [where, content] of Object.entries({
        "composer preview": preview,
        "payment request (html)": email.html,
        "payment request (text)": email.text,
      })) {
        expectOwnTextOnly(`${kind} ${where}`, content, texts[kind], foreign);
      }
      // The hosted consent page prints no T&C — and none of another service's.
      expectNoneOf(`${kind} consent page`, await consentPage(consentToken), foreign);
    }
  });

  it("8. no cross-org fallback: another organization's OWN flight override never reaches the new organization's flight order; that organization's car and hotel orders (no override) get the deployment car text and the built-in hotel text — never its flight override", async () => {
    // Own Flight Brand customises FLIGHT only, through Admin → Settings.
    const saved = await saveOwnLegal("other", "flight", OTHER_FLIGHT.terms, OTHER_FLIGHT.policy);
    expect(saved.termsVersion).toBe(FIRST_OWN_FLIGHT_VERSION);
    const texts = await preWritten();

    // The new organization's flight: the built-in text, never the override.
    const freshFlight = await submitOrder("fresh", orderBody("flight"));
    const freshStored = await storedOrder(freshFlight.id);
    expect(frozen(freshStored)).toEqual(BUILT_IN_FLIGHT);
    expectNoneOf("Fresh Brand flight snapshot", `${freshStored.terms.text}\n${freshStored.policy.text}`, [
      ...OTHER_MARKERS,
      OTHER_FLIGHT.terms,
      OTHER_FLIGHT.policy,
    ]);
    await generateLink("fresh", freshFlight.id);
    const { email } = await sendRequest("fresh", freshFlight.id);
    for (const [where, content] of Object.entries({ html: email.html, text: email.text })) {
      expectOwnTextOnly(`Fresh Brand flight payment request (${where})`, content, BUILT_IN_FLIGHT, [
        ...OTHER_MARKERS,
        ...otherServices(texts, "flight"),
      ]);
    }
    const resolved = await resolveServiceTerms({
      organizationId: orgIds.fresh,
      serviceType: ServiceType.FLIGHT,
    });
    expect(resolved).toMatchObject({
      termsAndConditions: DEFAULT_FLIGHT_TERMS_AND_CONDITIONS,
      termsVersion: DEFAULT_FLIGHT_LEGAL_VERSION,
      termsIsDefault: true,
      policyIsDefault: true,
    });

    // The override is that organization's own — its flight orders get it…
    const otherFlight = await storedOrder((await submitOrder("other", orderBody("flight"))).id);
    expect(otherFlight.terms).toEqual({ text: OTHER_FLIGHT.terms, version: FIRST_OWN_FLIGHT_VERSION });
    expect(otherFlight.policy).toMatchObject({
      text: OTHER_FLIGHT.policy,
      version: FIRST_OWN_FLIGHT_VERSION,
    });

    // …and only its flight orders: its car and hotel orders get their own
    // service's pre-written text.
    const otherCar = await storedOrder((await submitOrder("other", orderBody("car"))).id);
    const otherHotel = await storedOrder((await submitOrder("other", orderBody("hotel"))).id);
    expect(frozen(otherCar)).toEqual(texts.car);
    expect(frozen(otherHotel)).toEqual(BUILT_IN_HOTEL);
    for (const [where, doc] of Object.entries({ "car": otherCar, "hotel": otherHotel })) {
      expectNoneOf(`Own Flight Brand ${where} snapshot`, `${doc.terms.text}\n${doc.policy.text}`, [
        ...OTHER_MARKERS,
        ...lines(BUILT_IN_FLIGHT.terms),
      ]);
    }

    // The new organization's car and hotel orders: untouched by any of it.
    const freshCar = await storedOrder((await submitOrder("fresh", orderBody("car"))).id);
    const freshHotel = await storedOrder((await submitOrder("fresh", orderBody("hotel"))).id);
    expect(frozen(freshCar)).toEqual(texts.car);
    expect(frozen(freshHotel)).toEqual(BUILT_IN_HOTEL);
  });

  it("9. previews with no settings: renderEmailPreview for the new organization — car, flight and hotel × payment-request, payment-confirmation, payment-authorized — shows that service's pre-written terms and policy, never empty, never 'Admin → Settings', 'Configure' or 'of its own yet'", async () => {
    const texts = await preWritten();
    for (const kind of KINDS) {
      for (const templateKey of TEMPLATES) {
        const where = `${kind} ${templateKey} preview`;
        const preview = await renderEmailPreview({
          organizationId: String(orgIds.fresh),
          serviceType: SERVICE_OF[kind],
          templateKey,
        });
        expect(preview.provider, `${where}: no supplier sampled`).not.toBeNull();
        expect(preview.html.length, `${where} rendered nothing`).toBeGreaterThan(0);
        expectOwnTextOnly(where, preview.html, texts[kind], [
          ...otherServices(texts, kind),
          ...OTHER_MARKERS,
        ]);
        expect(readable(preview.html), where).toContain(`Terms version ${texts[kind].termsVersion}`);
        for (const [errand, re] of ADMIN_ERRANDS) {
          expect(preview.html, `${where} says "${errand}"`).not.toMatch(re);
          expect(readable(preview.html), `${where} says "${errand}"`).not.toMatch(re);
        }
      }
    }
  });

  it("10. real emails with no settings: each order's payment request (Stripe link, SMTP) carries its own service's terms only; a flight paid through the brand's Stripe webhook → outbox sends a confirmation with the flight terms", async () => {
    const texts = await preWritten();
    const stripeBefore = getCurrentTestStripe().sessionsCreated.length;
    const linked = {} as Record<Kind, OrderDTO>;
    for (const kind of KINDS) {
      const created = await submitOrder("fresh", orderBody(kind));
      linked[kind] = await generateLink("fresh", created.id);
      expect(linked[kind].payment.gateway, kind).toBe(PaymentGatewayKey.STRIPE);
      const { email } = await sendRequest("fresh", created.id);
      for (const [where, content] of Object.entries({ html: email.html, text: email.text })) {
        expectOwnTextOnly(`${kind} payment request (${where})`, content, texts[kind], [
          ...otherServices(texts, kind),
          ...OTHER_MARKERS,
        ]);
      }
      expect(readable(email.html)).toContain(`Terms version ${texts[kind].termsVersion}`);
    }
    // One Stripe Checkout session per order, on the brand's own Stripe.
    expect(getCurrentTestStripe().sessionsCreated.length - stripeBefore).toBe(3);

    // The customer pays the flight: Stripe → /api/webhooks/stripe/freshbrand
    // → the outbox → the confirmation email.
    const paid = await payWithStripe("fresh", linked.flight);
    expect(paid.delivered.status, JSON.stringify(paid.delivered.body)).toBe(200);
    expect(paid.drained.sent).toBe(1);
    expect((await orderApi("fresh", linked.flight.id)).status).toBe(OrderStatus.PAID);
    for (const [where, content] of Object.entries({
      html: paid.confirmation.html,
      text: paid.confirmation.text,
    })) {
      expectOwnTextOnly(`flight confirmation (${where})`, content, BUILT_IN_FLIGHT, [
        ...otherServices(texts, "flight"),
        ...OTHER_MARKERS,
      ]);
    }
    expect(readable(paid.confirmation.html)).toContain(`Terms version ${DEFAULT_FLIGHT_LEGAL_VERSION}`);
  });

  it(`11. optional override still works: the new organization saves its own FLIGHT terms (PATCH /api/admin/settings/legal) → its next flight order freezes exactly them at nextPolicyVersion(DEFAULT_FLIGHT_LEGAL_VERSION) = ${FIRST_OWN_FLIGHT_VERSION}; its car and hotel orders are unaffected`, async () => {
    const texts = await preWritten();
    const saved = await saveOwnLegal("fresh", "flight", FRESH_FLIGHT.terms, FRESH_FLIGHT.policy);
    expect(saved).toMatchObject({
      termsAndConditions: FRESH_FLIGHT.terms,
      termsVersion: FIRST_OWN_FLIGHT_VERSION,
      cancellationPolicy: FRESH_FLIGHT.policy,
      cancellationPolicyVersion: FIRST_OWN_FLIGHT_VERSION,
      termsIsDefault: false,
      policyIsDefault: false,
    });
    const override: LegalText = {
      terms: FRESH_FLIGHT.terms,
      termsVersion: FIRST_OWN_FLIGHT_VERSION,
      policy: FRESH_FLIGHT.policy,
      policyVersion: FIRST_OWN_FLIGHT_VERSION,
    };

    // Exactly the override — not one clause of the built-in text left.
    const flight = await submitOrder("fresh", orderBody("flight"));
    expect(frozen(await storedOrder(flight.id))).toEqual(override);
    await generateLink("fresh", flight.id);
    const { email } = await sendRequest("fresh", flight.id);
    expectOwnTextOnly("customised flight payment request", email.html, override, [
      ...linesOf(BUILT_IN_FLIGHT),
      ...linesOf(texts.car),
      ...linesOf(BUILT_IN_HOTEL),
    ]);

    // Another service's override is never used: car and hotel unchanged.
    const car = await storedOrder((await submitOrder("fresh", orderBody("car"))).id);
    const hotel = await storedOrder((await submitOrder("fresh", orderBody("hotel"))).id);
    expect(frozen(car)).toEqual(texts.car);
    expect(frozen(hotel)).toEqual(BUILT_IN_HOTEL);
    for (const [where, doc] of Object.entries({ car, hotel })) {
      expectNoneOf(`${where} snapshot`, `${doc.terms.text}\n${doc.policy.text}`, FRESH_MARKERS);
    }

    // The save wrote the FLIGHT slot and nothing else of the organization's.
    const raw = await Organization.findById(orgIds.fresh).lean<{
      legal?: {
        termsAndConditions?: string;
        cancellationPolicy?: string;
        services?: Record<string, Record<string, string> | null> | null;
      };
    } | null>();
    expect(raw!.legal!.services!.FLIGHT).toMatchObject({
      termsAndConditions: FRESH_FLIGHT.terms,
      cancellationPolicy: FRESH_FLIGHT.policy,
    });
    expect(raw!.legal!.services!.HOTEL ?? null).toBeNull();
    expect(raw!.legal!.termsAndConditions ?? "").toBe("");
    expect(raw!.legal!.cancellationPolicy ?? "").toBe("");
  });

  it("12. historical snapshots are unchanged: a flight order frozen with the built-in text BEFORE the override keeps it — re-read, its payment request re-sent, its payment confirmation and the operator's resend all still show the built-in text, never the override", async () => {
    const texts = await preWritten();
    const before = await submitOrder("fresh", orderBody("flight"));
    const linked = await generateLink("fresh", before.id);
    const firstRequest = await sendRequest("fresh", before.id);
    expectOwnTextOnly("payment request before the override", firstRequest.email.html, BUILT_IN_FLIGHT, FRESH_MARKERS);

    await saveOwnLegal("fresh", "flight", FRESH_FLIGHT.terms, FRESH_FLIGHT.policy);
    const mustNot = [...FRESH_MARKERS, ...otherServices(texts, "flight")];

    // Re-read from the database, and through the order API.
    expect(frozen(await storedOrder(before.id))).toEqual(BUILT_IN_FLIGHT);
    const reread = await orderApi("fresh", before.id);
    expect(reread.terms).toEqual({ text: BUILT_IN_FLIGHT.terms, version: DEFAULT_FLIGHT_LEGAL_VERSION });
    expect(reread.policy).toMatchObject({
      text: BUILT_IN_FLIGHT.policy,
      version: DEFAULT_FLIGHT_LEGAL_VERSION,
    });

    // The payment request re-sent after the override: still the frozen text.
    const resent = await sendRequest("fresh", before.id);
    for (const [where, content] of Object.entries({ html: resent.email.html, text: resent.email.text })) {
      expectOwnTextOnly(`re-sent payment request (${where})`, content, BUILT_IN_FLIGHT, mustNot);
    }

    // Paid after the override: the confirmation shows what the customer
    // was asked to agree to — the frozen built-in text.
    const paid = await payWithStripe("fresh", linked);
    expect(paid.delivered.status, JSON.stringify(paid.delivered.body)).toBe(200);
    expectOwnTextOnly("confirmation after the override", paid.confirmation.html, BUILT_IN_FLIGHT, mustNot);

    // The operator's resend: the same.
    const again = await resendConfirmation("fresh", before.id);
    for (const [where, content] of Object.entries({ html: again.html, text: again.text })) {
      expectOwnTextOnly(`resent confirmation (${where})`, content, BUILT_IN_FLIGHT, mustNot);
    }

    // Only a NEW flight order takes the override.
    const after = await storedOrder((await submitOrder("fresh", orderBody("flight"))).id);
    expect(after.terms).toEqual({ text: FRESH_FLIGHT.terms, version: FIRST_OWN_FLIGHT_VERSION });
    expect(frozen(await storedOrder(before.id))).toEqual(BUILT_IN_FLIGHT);
  });

  it("12b. the built-in rewording reaches new orders only: an order frozen with the PREVIOUS built-in flight text (v2 — no travel supplier, no PNR clause) keeps that text and label in its re-read, its payment request and its confirmation", async () => {
    // The v2 built-in flight terms, rebuilt from today's: the two v3
    // additions taken out. "v2" is the label that text was frozen under.
    const v3Only = lines(DEFAULT_FLIGHT_TERMS_AND_CONDITIONS).filter(
      (l) => l.includes("(PNR)") || l.includes("travel supplier"),
    );
    expect(v3Only).toHaveLength(2);
    const previous: LegalText = {
      terms: lines(DEFAULT_FLIGHT_TERMS_AND_CONDITIONS)
        .filter((l) => !l.includes("(PNR)"))
        .map((l) => l.replace(" and any travel supplier", ""))
        .join("\n"),
      termsVersion: "v2",
      policy: DEFAULT_FLIGHT_CANCELLATION_POLICY,
      policyVersion: "v2",
    };
    expect(previous.termsVersion).not.toBe(DEFAULT_FLIGHT_LEGAL_VERSION);

    // An order frozen before the rewording, exactly as the database holds one.
    const created = await submitOrder("fresh", orderBody("flight"));
    await Order.collection.updateOne(
      { _id: new Types.ObjectId(created.id) },
      {
        $set: {
          "terms.text": previous.terms,
          "terms.version": previous.termsVersion,
          "policy.version": previous.policyVersion,
        },
      },
    );

    const reread = await orderApi("fresh", created.id);
    expect(reread.terms).toEqual({ text: previous.terms, version: "v2" });
    const linked = await generateLink("fresh", created.id);
    const { email } = await sendRequest("fresh", created.id);
    const paid = await payWithStripe("fresh", linked);
    for (const [where, content] of Object.entries({
      "payment request (html)": email.html,
      "payment request (text)": email.text,
      "confirmation (html)": paid.confirmation.html,
    })) {
      expectOwnTextOnly(`v2 order ${where}`, content, previous, v3Only);
    }
    expect(readable(email.html)).toContain("Terms version v2");
    expect(readable(email.html)).not.toContain(`Terms version ${DEFAULT_FLIGHT_LEGAL_VERSION}`);
    expect(frozen(await storedOrder(created.id))).toEqual(previous);
  });
});

/* ------------------------------------------------------------------ *
 * 13–15 · A TripReservations-shaped organization
 * ------------------------------------------------------------------ */

describe("a TripReservations-shaped organization (PayPal, sells [CAR_RENTAL, FLIGHT], no legal at all)", () => {
  it("13. its flight order IMMEDIATELY freezes the built-in flight terms — no settings action first — and its PayPal payment request carries them, never the car text", async () => {
    const raw = await Organization.collection.findOne({ _id: orgIds.trip });
    expect(raw!).not.toHaveProperty("legal");
    expect(raw!.serviceTypes).toEqual([ServiceType.CAR_RENTAL, ServiceType.FLIGHT]);
    const texts = await preWritten();

    const flight = await submitOrder("trip", orderBody("flight"));
    expect(frozen(await storedOrder(flight.id))).toEqual(BUILT_IN_FLIGHT);

    const stripeBefore = getCurrentTestStripe().sessionsCreated.length;
    const linked = await generateLink("trip", flight.id);
    expect(linked.payment.gateway).toBe(PaymentGatewayKey.PAYPAL);
    expect(paypalCalls.filter((c) => c.url.endsWith("/v2/checkout/orders"))).toHaveLength(1);
    expect(getCurrentTestStripe().sessionsCreated.length).toBe(stripeBefore);

    const { email } = await sendRequest("trip", flight.id);
    for (const [where, content] of Object.entries({ html: email.html, text: email.text })) {
      expectOwnTextOnly(`Trip Reservations flight payment request (${where})`, content, BUILT_IN_FLIGHT, [
        ...otherServices(texts, "flight"),
        ...OTHER_MARKERS,
      ]);
    }
  });

  it("14. its car order freezes the deployment's pre-written car text", async () => {
    const settings = await getSettings();
    const car = await storedOrder((await submitOrder("trip", orderBody("car"))).id);
    expect(car.terms).toEqual({ text: settings.termsAndConditions, version: settings.termsVersion });
    expect(car.policy).toMatchObject({
      text: settings.cancellationPolicy,
      version: settings.cancellationPolicyVersion,
    });
    expectNotEmpty("Trip Reservations car snapshot", frozen(car));
    expectNoneOf("Trip Reservations car snapshot", `${car.terms.text}\n${car.policy.text}`, [
      ...linesOf(BUILT_IN_FLIGHT),
      ...linesOf(BUILT_IN_HOTEL),
    ]);
  });

  it("15. resolveServiceTerms(HOTEL) returns the built-in hotel text although it does not sell hotel stays; a hotel order is refused ONLY because HOTEL is not sold — once sold, the same order is created with the built-in hotel text", async () => {
    const resolved = await resolveServiceTerms({
      organizationId: orgIds.trip,
      serviceType: ServiceType.HOTEL,
    });
    expect(resolved).toEqual({
      termsAndConditions: DEFAULT_HOTEL_TERMS_AND_CONDITIONS,
      termsVersion: DEFAULT_HOTEL_LEGAL_VERSION,
      cancellationPolicy: DEFAULT_HOTEL_CANCELLATION_POLICY,
      cancellationPolicyVersion: DEFAULT_HOTEL_LEGAL_VERSION,
      termsIsDefault: true,
      policyIsDefault: true,
    });

    // Refused — and the reason is the service, not the terms.
    await actingAs("trip");
    const refused = await jsonBody<{ ok: false; error: { message: string } }>(
      await createOrderRoute(buildRequest("/api/orders", { method: "POST", body: orderBody("hotel") })),
    );
    expect(refused.status).toBe(422);
    expect(refused.body.error.message).toBe(
      `${ORG.trip.brandName} does not sell hotel stays, so this order cannot be created for it.`,
    );
    expect(refused.body.error.message).not.toMatch(/terms|policy|settings/i);
    expect(await Order.countDocuments({})).toBe(0);

    // Selling hotel stays is the only thing missing: with HOTEL added (and
    // still no legal of any kind) the same order is created.
    await Organization.collection.updateOne(
      { _id: orgIds.trip },
      { $set: { serviceTypes: [ServiceType.CAR_RENTAL, ServiceType.FLIGHT, ServiceType.HOTEL] } },
    );
    const hotel = await storedOrder((await submitOrder("trip", orderBody("hotel"))).id);
    expect(frozen(hotel)).toEqual(BUILT_IN_HOTEL);
  });
});

/* ------------------------------------------------------------------ *
 * Never empty
 * ------------------------------------------------------------------ */

describe("car terms are never empty — the built-in car text backs the deployment's", () => {
  it("the deployment car text blank (raw update to empty strings, stale version labels kept): a car order still freezes the built-in DEFAULT_TERMS_AND_CONDITIONS / DEFAULT_CANCELLATION_POLICY under the built-in label — never empty — and the car preview shows them", async () => {
    await Setting.collection.updateOne(
      { key: SETTINGS_KEY },
      {
        $set: {
          termsAndConditions: "",
          cancellationPolicy: "",
          termsVersion: "v7",
          cancellationPolicyVersion: "v6",
        },
      },
    );
    // Precondition: the deployment really serves blank car text now.
    const settings = await getSettings();
    expect(settings.termsAndConditions).toBe("");
    expect(settings.cancellationPolicy).toBe("");

    const builtInCar: LegalText = {
      terms: DEFAULT_TERMS_AND_CONDITIONS,
      termsVersion: BUILT_IN_CAR_TERMS_VERSION,
      policy: DEFAULT_CANCELLATION_POLICY,
      policyVersion: BUILT_IN_CAR_POLICY_VERSION,
    };
    for (const key of ["fresh", "trip"] as const) {
      const car = await storedOrder((await submitOrder(key, orderBody("car"))).id);
      expect(frozen(car), key).toEqual(builtInCar);
      expectNotEmpty(`${key} car snapshot`, frozen(car));
      // The blank text's labels never travel with the built-in text.
      expect(car.terms.version, key).not.toBe("v7");
      expect(car.policy.version, key).not.toBe("v6");
    }

    const preview = await renderEmailPreview({
      organizationId: String(orgIds.fresh),
      serviceType: ServiceType.CAR_RENTAL,
      templateKey: "payment-request",
    });
    expectOwnTextOnly("car preview with blank deployment text", preview.html, builtInCar, [
      ...linesOf(BUILT_IN_FLIGHT),
      ...linesOf(BUILT_IN_HOTEL),
    ]);
  });

  it("a deployment whose Settings document was never created: a car order freezes the built-in car text, as getSettings serves it", async () => {
    await Setting.deleteMany({});
    const served = await deploymentCarText();
    expect(served.terms).toBe(DEFAULT_TERMS_AND_CONDITIONS);
    expect(served.policy).toBe(DEFAULT_CANCELLATION_POLICY);

    const car = await storedOrder((await submitOrder("fresh", orderBody("car"))).id);
    expect(frozen(car)).toEqual(served);
    expectNotEmpty("car snapshot without Settings", frozen(car));
  });
});

/* ------------------------------------------------------------------ *
 * Nothing on screen asks anyone to set terms up
 * ------------------------------------------------------------------ */

describe("nothing asks an operator to set terms up", () => {
  it("the new organization's create page: three tabs, every panel force-mounted, no terms notice in any of them — and create-config carries no legalStatus", async () => {
    await actingAs("fresh");
    const html = renderToStaticMarkup(withQueryClient(await CreateOrderPage()));
    expect(html).toContain('role="tablist"');
    const panels = html.split('role="tabpanel"').slice(1);
    expect(panels).toHaveLength(3);
    for (const [i, panel] of panels.entries()) {
      const read = readable(panel);
      for (const wording of [/of its own yet/i, /built-in/i, /terms in use/i, /will freeze/i, /Admin → Settings/, /ask an admin/i]) {
        expect(read, `panel ${i + 1}: ${wording}`).not.toMatch(wording);
      }
    }
    expect(html).not.toContain('href="/app/admin/settings"');
    expect(html).not.toContain('role="alert"');

    const config = await ok<Record<string, unknown>>(await createConfigRoute());
    expect(config.serviceTypes).toEqual(ALL_SERVICES);
    expect(config).not.toHaveProperty("legalStatus");
  });

  it("Admin → Settings is optional customisation: each service's form holds its pre-written text, 'ready to use, nothing to set up' — never 'of its own yet' — and opening it saves nothing", async () => {
    await actingAs("fresh");
    const texts = await preWritten();
    const html = renderToStaticMarkup(await AdminSettingsPage());
    const brand = ORG.fresh.brandName;
    for (const [noun, defaultName] of [
      ["car rental", "the deployment default shown here"],
      ["flight", "this built-in default"],
      ["hotel", "this built-in default"],
    ] as const) {
      expect(html).toContain(
        `New ${noun} orders for ${brand} use ${defaultName} — ready to use, nothing to set up. Optional: edit it and save to give ${brand} its own wording; no other brand changes.`,
      );
    }
    expect(readable(html)).not.toMatch(/of its own yet/i);
    // Each form is filled with exactly what that service's orders freeze.
    const read = readable(html);
    for (const kind of KINDS) {
      for (const clause of linesOf(texts[kind])) {
        expect(read, `${kind} form: "${clause}"`).toContain(clause);
      }
    }
    expect(
      await AuditLog.countDocuments({ action: AuditAction.ORGANIZATION_LEGAL_UPDATED }),
    ).toBe(0);
    expect(await Organization.collection.findOne({ _id: orgIds.fresh })).not.toHaveProperty("legal");
  });
});
