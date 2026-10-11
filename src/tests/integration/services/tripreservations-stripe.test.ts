import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Types } from "mongoose";

import {
  GET as consentViewRoute,
  POST as confirmConsentRoute,
} from "@/app/api/consent/[token]/route";
import { GET as organizationsRoute } from "@/app/api/organizations/route";
import { POST as createOrderRoute } from "@/app/api/orders/route";
import { GET as getOrderRoute } from "@/app/api/orders/[id]/route";
import { POST as generateLinkRoute } from "@/app/api/orders/[id]/generate-payment-link/route";
import { POST as previewRoute } from "@/app/api/orders/[id]/payment-request-preview/route";
import { POST as sendRequestRoute } from "@/app/api/orders/[id]/send-payment-request/route";
import { POST as stripeWebhookRoute } from "@/app/api/webhooks/stripe/[orgSlug]/route";
import ConsentPage from "@/app/consent/[token]/page";
import PaymentSuccessPage from "@/app/pay/success/page";
import { EmailComposer } from "@/components/features/orders/email-composer";
import { ActivityFeedProvider } from "@/hooks/use-activity-feed";
import {
  AuditAction,
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
import { env } from "@/lib/env";
import {
  AuditLog,
  Branding,
  Order,
  OrderEvidence,
  Organization,
  OrganizationCredential,
  OrganizationMember,
} from "@/server/db/models";
import { orgCookieName } from "@/server/auth/org-cookie";
import { formatEmailDate } from "@/server/email/format";
import { getDefaultGateway } from "@/server/payments/gateways";
import { _setPayPalFetchForTesting } from "@/server/payments/gateways/paypal";
import { getGatewayForOrganization } from "@/server/payments/resolve-gateway";
import { createProvider } from "@/server/services/provider.service";
import { createSettings } from "@/tests/factories/settings.factory";
import {
  buildCheckoutCompleted,
  signWebhook,
} from "@/tests/factories/stripe-event.factory";
import {
  roundTripFlightInput,
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
 * ENABLE STRIPE FOR TRIPRESERVATIONS — through the configuration that already
 * exists for exactly this — and keep PayPal as its default. No source is
 * changed: this file proves the existing mechanism does the job.
 *
 * THE MECHANISM:
 *
 *   payments.provider          the DEFAULT gateway of a new payment link
 *                              — stays PAYPAL
 *   payments.enabledProviders  every gateway the brand may use
 *                              — [PAYPAL] becomes [PAYPAL, STRIPE]
 *   ORG_TRIPRESERVATIONS_STRIPE_SECRET_KEY / _STRIPE_WEBHOOK_SECRET
 *                              its OWN Stripe account (env first, vault
 *                              second) — set here as test values
 *
 *   The operator picks per order in the email composer, which reads GET
 *   /api/organizations → payments; generate-payment-link posts the choice and
 *   `getGatewayForOrganization` honours it only for an ENABLED provider. A
 *   non-default brand with no Stripe credentials is REFUSED — it never falls
 *   back to the deployment's STRIPE_SECRET_KEY, which is the default brand's.
 *
 * THE WORLD (production, read-only facts):
 *
 *   rentalconfirmation   the DEFAULT organization, Stripe, enabledProviders
 *                        [STRIPE], the deployment key, automatic capture
 *   tripreservations     PayPal default, sells [CAR_RENTAL, FLIGHT] (no
 *                        hotels), no capture mode stored (automatic) — and
 *                        here Stripe ENABLED the way production would enable
 *                        it: enabledProviders [PAYPAL, STRIPE] (one field) +
 *                        its own test keys in env
 *   globevista           "FlightBizz", Stripe [STRIPE], its own
 *                        ORG_GLOBEVISTA_STRIPE_SECRET_KEY, MANUAL capture
 *   coastaltrips         a fourth brand, PayPal-only ([PAYPAL]) — Stripe is
 *                        not enabled for everyone
 *
 * Every assertion is on what the real route handlers did — with an
 * authenticated operator and the selected-organization cookie — and on what
 * was rendered or sent: the Stripe Checkout session the stub recorded, the
 * SECRET KEY its client was requested with (a spy on `getStripeFor`: the stub
 * itself answers for any key, so the spy is what tells the accounts apart),
 * every PayPal request, the emails as they left SMTP, the consent and receipt
 * pages, signed webhooks to the per-organization endpoint, and the email
 * composer itself — rendered in a scoped jsdom with the REAL
 * /api/organizations payload behind its fetch.
 *
 *   1.   enabled      the stored configuration and what the composer reads
 *   2.   admin UI     the composer's gateway choice, and what it posts
 *   3–5. flight      the Stripe session / the emails + consent page / the
 *                    signed webhook and the confirmation
 *   6.   car          a TripReservations car rental on Stripe
 *   7.   default      PayPal stays the default; no service changes
 *   8.   other orgs   rentalconfirmation, globevista, the PayPal-only brand,
 *                    and a Stripe-enabled brand with no Stripe keys (refused)
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
      sentMail.push({ ...m, __transport: "deployment" });
      return { messageId: "<deployment>", response: "250 OK" };
    },
  }),
  getMailerFor: (cfg: { user: string }) => ({
    sendMail: async (m: Record<string, unknown>) => {
      sentMail.push({ ...m, __transport: `org:${cfg.user}` });
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

type OrgKey = "rc" | "trip" | "gv" | "coast";

/** The deployment Branding singleton — RentalConfirmation's, in production. */
const RC = {
  slug: "rentalconfirmation",
  brandName: "Rental Confirmation",
  supportEmail: "support@rentalconfirmation.com",
  supportPhone: "+15513071441",
} as const;

/** Trip Reservations as configured in production: its own mailbox and
 *  transport, its own support address, no phone. */
const TRIP = {
  slug: "tripreservations",
  brandName: "Trip Reservations",
  supportEmail: "contact@tripreservations.test",
  fromEmail: "contact@tripreservations.test",
} as const;

/** GlobeVista: operations name; FlightBizz is the name its customers see. */
const GV = {
  slug: "globevista",
  name: "GlobeVista",
  brandName: "FlightBizz",
  supportEmail: "support@flightbizz.test",
  fromEmail: "bookings@flightbizz.test",
} as const;

/** A fourth brand that takes PayPal and nothing else. */
const COAST = {
  slug: "coastaltrips",
  brandName: "Coastal Trips",
  supportEmail: "help@coastaltrips.test",
} as const;

const SLUG: Record<OrgKey, string> = {
  rc: RC.slug,
  trip: TRIP.slug,
  gv: GV.slug,
  coast: COAST.slug,
};

/** TripReservations' own Stripe account — TEST credentials, set in-test the
 *  way production sets them (the deployment's env), cleaned up after. */
const TRIP_STRIPE_SECRET_KEY = "sk_test_tripreservations_only";
const TRIP_STRIPE_WEBHOOK_SECRET = "whsec_tripreservations_only";
const TRIP_STRIPE_ENV: Record<string, string> = {
  ORG_TRIPRESERVATIONS_STRIPE_SECRET_KEY: TRIP_STRIPE_SECRET_KEY,
  ORG_TRIPRESERVATIONS_STRIPE_WEBHOOK_SECRET: TRIP_STRIPE_WEBHOOK_SECRET,
};

const GV_STRIPE_SECRET_KEY = "sk_test_globevista_only";

/** Everything else the world already has in env: TripReservations' PayPal
 *  account and mailbox, FlightBizz's Stripe account, Coastal Trips' PayPal. */
const WORLD_ENV: Record<string, string> = {
  ORG_TRIPRESERVATIONS_PAYPAL_CLIENT_ID: "tripreservations-client-id",
  ORG_TRIPRESERVATIONS_PAYPAL_CLIENT_SECRET: "tripreservations-client-secret",
  ORG_TRIPRESERVATIONS_PAYPAL_WEBHOOK_ID: "WEBHOOK-TRIPRESERVATIONS",
  ORG_TRIPRESERVATIONS_PAYPAL_SANDBOX: "true",
  ORG_TRIPRESERVATIONS_SMTP_PASSWORD: "app-password",
  ORG_GLOBEVISTA_STRIPE_SECRET_KEY: GV_STRIPE_SECRET_KEY,
  ORG_GLOBEVISTA_STRIPE_WEBHOOK_SECRET: "whsec_globevista_only",
  ORG_COASTALTRIPS_PAYPAL_CLIENT_ID: "coastaltrips-client-id",
  ORG_COASTALTRIPS_PAYPAL_CLIENT_SECRET: "coastaltrips-client-secret",
  ORG_COASTALTRIPS_PAYPAL_WEBHOOK_ID: "WEBHOOK-COASTALTRIPS",
  ORG_COASTALTRIPS_PAYPAL_SANDBOX: "true",
};

const TOUCHED_ENV = [...Object.keys(WORLD_ENV), ...Object.keys(TRIP_STRIPE_ENV)];

/* The suppliers are global: no organization restriction. */
const CAR_SUPPLIER = "Budget";
const AIRLINE = "Air India";
const AIRLINE_KEY = "AIRINDIA";
const HOTEL_SUPPLIER_KEY = "HARBOURSTAYS";

/* The flight: a ROUND TRIP Delhi → Varanasi → Mumbai and back, the airline
 * charge ($400) in its own field, ONE charge — named by the operator — that
 * the link collects ($100). */
const FLIGHT_CHARGE = "Rental Cost";
const OUTBOUND = "Delhi → Varanasi → Mumbai";
/** What the gateway shows beside the amount, after the charge's name. */
const DEPARTS_RETURNS = "Departs: Sat, Oct 10, 2026 10:30 AM • Returns: Thu, Oct 15, 2026 9:00 AM";
const EXPLAINER =
  "Airline Charge is shown for the total booking value and is not collected through this payment link.";

/** A flight's rows and words — never on a car rental's surfaces. */
const FLIGHT_PHRASES = [
  "Airline Charge",
  "Total Booking Value",
  "Amount Payable Now",
  "Not collected through this payment link",
  "Price breakdown",
  "Flight itinerary",
  "Airline / Supplier",
];

/** The car email's money rows, as brand-leak.test.ts pins them. */
const CAR_ROWS =
  "What you're paying Rental cost $249.99 Deposit (due at counter) $100.00 " +
  "Amount paid online $249.99 Amount due at counter $100.00 Total rental cost $349.99";

const NOT_SOLD_HOTEL =
  "Trip Reservations does not sell hotel stays, so this order cannot be created for it.";
const STRIPE_NOT_CONFIGURED =
  "Trip Reservations has no Stripe credentials configured. Add them in organization settings before generating a payment link.";

const operator = actorFor(UserRole.ADMIN, { name: "Olivia Operator" });

let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;
const orgIds = {} as Record<OrgKey, Types.ObjectId>;
/** TripReservations' stored document exactly as production has it today —
 *  PayPal only — captured just before Stripe is enabled. */
let tripAsInProduction: Record<string, unknown> = {};
let envBefore: Record<string, string | undefined> = {};
/** Every PayPal API call the stub answered (OAuth excepted), in order. */
let paypalCalls: { url: string; body: unknown }[] = [];
/** Every PayPal request of any kind, OAuth included. */
let paypalFetches = 0;
/** The client id of each PayPal account that asked for an OAuth token. */
let paypalClientIds: string[] = [];
let paypalOrderSeq = 0;
let ipSeq = 0;

function uniqueIp(): string {
  ipSeq += 1;
  return `10.88.${Math.floor(ipSeq / 250)}.${ipSeq % 250}`;
}

async function memberOf(orgId: Types.ObjectId) {
  await OrganizationMember.create({
    organizationId: orgId,
    userId: new Types.ObjectId(operator.id),
    role: operator.role,
    status: RecordState.ACTIVE,
  });
}

/** Remove keys with the raw driver: the document then looks exactly like a
 *  production row written before those fields existed. */
async function unsetRaw(orgId: Types.ObjectId, paths: string[]) {
  await Organization.collection.updateOne(
    { _id: orgId },
    { $unset: Object.fromEntries(paths.map((p) => [p, ""])) },
  );
}

async function makeRentalConfirmation(): Promise<Types.ObjectId> {
  const doc = await Organization.create({
    slug: RC.slug,
    name: RC.brandName,
    brandName: RC.brandName,
    isDefault: true,
    payments: {
      provider: PaymentGatewayKey.STRIPE,
      enabledProviders: [PaymentGatewayKey.STRIPE],
    },
    support: { email: RC.supportEmail, phone: RC.supportPhone },
  });
  const id = doc._id as Types.ObjectId;
  await unsetRaw(id, ["serviceTypes", "legal"]);
  await memberOf(id);
  return id;
}

async function makeTripReservations(): Promise<Types.ObjectId> {
  const doc = await Organization.create({
    slug: TRIP.slug,
    name: TRIP.brandName,
    brandName: TRIP.brandName,
    isDefault: false,
    payments: {
      provider: PaymentGatewayKey.PAYPAL,
      enabledProviders: [PaymentGatewayKey.PAYPAL],
    },
    serviceTypes: [ServiceType.CAR_RENTAL, ServiceType.FLIGHT],
    email: {
      fromName: TRIP.brandName,
      fromEmail: TRIP.fromEmail,
      replyTo: "",
      transport: { host: "smtp.gmail.com", port: 587, secure: false, user: TRIP.fromEmail },
    },
    support: { email: TRIP.supportEmail, phone: "" },
  });
  const id = doc._id as Types.ObjectId;
  // No legal of its own, no capture mode stored: automatic.
  await unsetRaw(id, ["legal", "payments.captureMode"]);
  await memberOf(id);
  return id;
}

async function makeGlobeVista(): Promise<Types.ObjectId> {
  const doc = await Organization.create({
    slug: GV.slug,
    name: GV.name,
    brandName: GV.brandName,
    isDefault: false,
    payments: {
      provider: PaymentGatewayKey.STRIPE,
      enabledProviders: [PaymentGatewayKey.STRIPE],
      captureMode: CaptureMode.MANUAL,
    },
    serviceTypes: [ServiceType.FLIGHT, ServiceType.HOTEL, ServiceType.CAR_RENTAL],
    email: { fromName: GV.brandName, fromEmail: GV.fromEmail, replyTo: "" },
    support: { email: GV.supportEmail, phone: "" },
  });
  const id = doc._id as Types.ObjectId;
  await memberOf(id);
  return id;
}

async function makeCoastalTrips(): Promise<Types.ObjectId> {
  const doc = await Organization.create({
    slug: COAST.slug,
    name: COAST.brandName,
    brandName: COAST.brandName,
    isDefault: false,
    payments: {
      provider: PaymentGatewayKey.PAYPAL,
      enabledProviders: [PaymentGatewayKey.PAYPAL],
    },
    serviceTypes: [ServiceType.CAR_RENTAL, ServiceType.FLIGHT],
    support: { email: COAST.supportEmail, phone: "" },
  });
  const id = doc._id as Types.ObjectId;
  await unsetRaw(id, ["legal", "payments.captureMode"]);
  await memberOf(id);
  return id;
}

/**
 * ENABLE STRIPE FOR TRIPRESERVATIONS, the way production would: ONE field on
 * its organization document (written narrowly with the raw driver, as an
 * operator's update would be — `provider` stays PAYPAL) and its own Stripe
 * credentials in the deployment's env. Nothing else.
 */
async function enableStripeForTripReservations() {
  await Organization.collection.updateOne(
    { _id: orgIds.trip },
    {
      $set: {
        "payments.enabledProviders": [PaymentGatewayKey.PAYPAL, PaymentGatewayKey.STRIPE],
      },
    },
  );
  Object.assign(process.env, TRIP_STRIPE_ENV);
}

/** The operator, signed in, working in `key`'s organization. */
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

/** Minimal PayPal API — OAuth, order creation, webhook verification, capture
 *  — recording every request. Never the network. */
function stubPayPal() {
  paypalCalls = [];
  paypalFetches = 0;
  paypalClientIds = [];
  _setPayPalFetchForTesting((async (input: RequestInfo | URL, init?: RequestInit) => {
    paypalFetches += 1;
    const url = String(input);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (url.includes("/v1/oauth2/token")) {
      const basic = (new Headers(init?.headers).get("authorization") ?? "").replace(/^Basic /, "");
      paypalClientIds.push(Buffer.from(basic, "base64").toString("utf8").split(":")[0] ?? "");
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
    const id = `PP-ORDER-${paypalOrderSeq}`;
    return json({
      id,
      status: "PAYER_ACTION_REQUIRED",
      links: [{ rel: "payer-action", href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }],
    });
  }) as unknown as typeof fetch);
}

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  await Branding.findOneAndUpdate(
    { key: "default" },
    {
      $set: {
        key: "default",
        brandName: RC.brandName,
        supportEmail: RC.supportEmail,
        supportPhone: RC.supportPhone,
        primaryColor: "#0B1220",
      },
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );
  envBefore = Object.fromEntries(TOUCHED_ENV.map((k) => [k, process.env[k]]));
  for (const k of Object.keys(TRIP_STRIPE_ENV)) delete process.env[k];
  Object.assign(process.env, WORLD_ENV);
  sentMail.length = 0;
  stubPayPal();
  orgIds.rc = await makeRentalConfirmation();
  orgIds.trip = await makeTripReservations();
  orgIds.gv = await makeGlobeVista();
  orgIds.coast = await makeCoastalTrips();
  await actingAs("trip");
  // Global suppliers: a car supplier, an airline, a hotel supplier.
  const suppliers = [
    { key: "BUDGET", name: CAR_SUPPLIER, serviceType: ServiceType.CAR_RENTAL, logo: "/providers/budget.png", primaryColor: "#E8590C", tagline: "Value-focused rentals" },
    { key: AIRLINE_KEY, name: AIRLINE, serviceType: ServiceType.FLIGHT, logo: "/providers/air-india.png", primaryColor: "#C8102E", tagline: "" },
    { key: HOTEL_SUPPLIER_KEY, name: "Harbour Stays", serviceType: ServiceType.HOTEL, logo: "/providers/preview.png", primaryColor: "#0B3D91", tagline: "" },
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
  // TripReservations as production has it today: PayPal only…
  tripAsInProduction = await rawOrg("trip");
  // …then Stripe enabled through the existing configuration.
  await enableStripeForTripReservations();
  anonymous();
});

afterEach(() => {
  sessionMock?.restore();
  sessionMock = null;
  _setPayPalFetchForTesting(null);
  for (const k of TOUCHED_ENV) {
    const before = envBefore[k];
    if (before === undefined) delete process.env[k];
    else process.env[k] = before;
  }
  setNextHeaders({});
});

/* ------------------------------------------------------------------ *
 * Reading what the operator and the customer read
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

/** Raw content with every percent-encoded run decoded (mailto / tel links). */
function decoded(content: string): string {
  return content.replace(/&amp;/g, "&").replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
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

/** Every value under a key that names money, anywhere in a gateway request. */
function amountsIn(value: unknown): unknown[] {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, v]) =>
    /amount/i.test(key) ? [v] : amountsIn(v),
  );
}

/** Every leaf of a value: its numbers and its strings. */
function leavesOf(
  value: unknown,
  out: { numbers: number[]; strings: string[] } = { numbers: [], strings: [] },
) {
  if (typeof value === "number") out.numbers.push(value);
  else if (typeof value === "string") out.strings.push(value);
  else if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) leavesOf(v, out);
  }
  return out;
}

/**
 * None of `figures` anywhere in a gateway request: not as a number, and not
 * as a figure inside any string ("400", "400.00", "$500"). Digits that are
 * part of something else — an ObjectId, an order number, a date, epoch
 * seconds — are not figures, so they cannot make this flaky.
 */
function expectNoFigures(where: string, request: unknown, figures: string[]) {
  const { numbers, strings } = leavesOf(request);
  for (const n of numbers) {
    expect(figures.map(Number), `${where} carries the number ${n}`).not.toContain(n);
  }
  const figure = new RegExp(
    `(?<![\\w.])\\$?(?:${figures.map((f) => f.replace(/\./g, "\\.")).join("|")})(?:\\.0{1,2})?(?![\\w.])`,
  );
  for (const s of strings) {
    expect(s, `${where} carries one of ${figures.join(" / ")}`).not.toMatch(figure);
  }
}

/** Replace everything that legitimately varies per run (as
 *  stripe-session.characterization.test.ts does), so what remains is the
 *  shape and the constants. */
function normalise(
  value: unknown,
  ids: { orderId: string; orderNumber: string; actorId: string },
): unknown {
  const json = JSON.stringify(value)
    .split(ids.orderId)
    .join("<ORDER_ID>")
    .split(ids.orderNumber)
    .join("<ORDER_NUMBER>")
    .split(ids.actorId)
    .join("<ACTOR_ID>")
    .replace(/\d{4}-\d{2}-\d{2}/g, "<DATE>");
  const parsed = JSON.parse(json) as Record<string, unknown>;
  if (typeof parsed.expires_at === "number") parsed.expires_at = "<EPOCH_SECONDS>";
  return parsed;
}

function idsOf(order: OrderDTO) {
  return { orderId: order.id, orderNumber: order.orderNumber, actorId: operator.id };
}

/** The Stripe Checkout session every CAR rental sends — the characterization
 *  pins (Budget • Toyota Camry rental, $249.99 prepaid), only the merchant's
 *  name differing by brand. */
function carSessionExpectation(brandName: string) {
  return {
    mode: "payment",
    payment_method_types: ["card"],
    customer_email: "ada@payops.test",
    client_reference_id: "<ORDER_ID>",
    success_url:
      "http://localhost:3000/pay/success?order=<ORDER_NUMBER>&session_id={CHECKOUT_SESSION_ID}",
    cancel_url: "http://localhost:3000/pay/cancelled?order=<ORDER_NUMBER>",
    expires_at: "<EPOCH_SECONDS>",
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: 24999,
          product_data: {
            name: `${CAR_SUPPLIER} • Toyota Camry rental`,
            description:
              "Pick-up: <DATE> (LAX Airport — Terminal 1) • Drop-off: <DATE> (San Diego Downtown)",
          },
        },
      },
    ],
    metadata: {
      orderId: "<ORDER_ID>",
      orderNumber: "<ORDER_NUMBER>",
      bookingType: "NEW_BOOKING",
      actorId: "<ACTOR_ID>",
      actorEmail: operator.email,
      appName: brandName,
    },
    payment_intent_data: {
      description: `${brandName} • <ORDER_NUMBER>`,
      metadata: { orderId: "<ORDER_ID>", orderNumber: "<ORDER_NUMBER>" },
    },
  };
}

/** The Stripe Checkout session TripReservations' flight sends: the $100
 *  charge alone, led by its name — automatic capture, Trip Reservations as
 *  the merchant. */
function tripFlightSessionExpectation() {
  return {
    mode: "payment",
    payment_method_types: ["card"],
    customer_email: "grace@payops.test",
    client_reference_id: "<ORDER_ID>",
    success_url:
      "http://localhost:3000/pay/success?order=<ORDER_NUMBER>&session_id={CHECKOUT_SESSION_ID}",
    cancel_url: "http://localhost:3000/pay/cancelled?order=<ORDER_NUMBER>",
    expires_at: "<EPOCH_SECONDS>",
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: 10000,
          product_data: {
            name: `${FLIGHT_CHARGE} • ${AIRLINE} • ${OUTBOUND} (round trip)`,
            description: `${FLIGHT_CHARGE} • ${DEPARTS_RETURNS}`,
          },
        },
      },
    ],
    metadata: {
      orderId: "<ORDER_ID>",
      orderNumber: "<ORDER_NUMBER>",
      bookingType: "NEW_BOOKING",
      actorId: "<ACTOR_ID>",
      actorEmail: operator.email,
      appName: TRIP.brandName,
    },
    payment_intent_data: {
      description: `${TRIP.brandName} • <ORDER_NUMBER>`,
      metadata: { orderId: "<ORDER_ID>", orderNumber: "<ORDER_NUMBER>" },
    },
  };
}

/** An organization exactly as stored — raw driver, no Mongoose defaults —
 *  as plain JSON (ids and dates as strings) so it compares by value. */
async function rawOrg(key: OrgKey): Promise<Record<string, unknown>> {
  const doc = await Organization.collection.findOne({ slug: SLUG[key] });
  expect(doc, `organization ${SLUG[key]} is missing`).toBeTruthy();
  return JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
}

/* ------------------------------------------------------------------ *
 * What the operator, the customer and the gateways do — real routes
 * ------------------------------------------------------------------ */

const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

async function ok<T>(res: Response, status = 200): Promise<T> {
  const { status: got, body } = await jsonBody<{ ok: boolean; data: T }>(res);
  expect(got, JSON.stringify(body)).toBe(status);
  return body.data;
}

interface ApiError {
  ok: false;
  error: { code: string; message: string };
}

interface OrganizationsPayload {
  organizations: { slug: string }[];
  selectedId: string | null;
  payments: {
    provider: PaymentGatewayKey;
    enabledProviders: PaymentGatewayKey[];
    captureMode: CaptureMode;
  } | null;
  serviceTypes: ServiceType[];
}

/** GET /api/organizations, as `key`'s operator — exactly what the email
 *  composer reads. The raw JSON text is kept: it is what the composer's
 *  fetch is answered with below. */
async function organizationsApi(key: OrgKey) {
  await actingAs(key);
  const res = await organizationsRoute();
  const text = await res.text();
  expect(res.status, text).toBe(200);
  return { text, data: (JSON.parse(text) as { data: OrganizationsPayload }).data };
}

/** The secret key of every Stripe client requested while `fn` runs. The test
 *  stub answers for ANY key, so this spy on `getStripeFor` is what says which
 *  merchant account a session (or a webhook verification) was made on. */
async function stripeKeysDuring<T>(fn: () => Promise<T>): Promise<{ result: T; keys: string[] }> {
  const client = await import("@/server/payments/stripe");
  const spy = vi.spyOn(client, "getStripeFor");
  try {
    const result = await fn();
    return { result, keys: spy.mock.calls.map(([key]) => key) };
  } finally {
    spy.mockRestore();
  }
}

/** POST /api/orders — the raw reply, for a refusal. */
async function postOrder(key: OrgKey, body: unknown) {
  await actingAs(key);
  return jsonBody<{ ok: boolean; data: { order: OrderDTO } } & Partial<ApiError>>(
    await createOrderRoute(buildRequest("/api/orders", { method: "POST", body })),
  );
}

/** POST /api/orders — the create form's submit, expected to succeed. */
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

/**
 * POST /api/orders/[id]/generate-payment-link with exactly `body` — what the
 * composer posts: `{ gateway }` when the brand offers a choice, `{}` when it
 * has one gateway. Returns the reply, every Stripe session and PayPal order
 * the link created, how many PayPal requests it made at all, and the secret
 * key of every Stripe client it asked for.
 */
async function generateLink(key: OrgKey, orderId: string, body: Record<string, unknown>) {
  await actingAs(key);
  const stripeBefore = getCurrentTestStripe().sessionsCreated.length;
  const paypalBefore = paypalCalls.length;
  const fetchesBefore = paypalFetches;
  const { result: res, keys } = await stripeKeysDuring(() =>
    generateLinkRoute(
      buildRequest(`/api/orders/${orderId}/generate-payment-link`, { method: "POST", body }),
      idParams(orderId),
    ),
  );
  const reply = await jsonBody<{ ok: boolean; data?: { order: OrderDTO } } & Partial<ApiError>>(res);
  const sessions = getCurrentTestStripe().sessionsCreated.slice(stripeBefore);
  return {
    status: reply.status,
    json: reply.body,
    order: reply.body.data?.order ?? null,
    sessions,
    stripe: sessions.map((s) => s.params),
    paypal: paypalCalls
      .slice(paypalBefore)
      .filter((c) => c.url.endsWith("/v2/checkout/orders"))
      .map((c) => c.body as PayPalOrderBody),
    paypalFetches: paypalFetches - fetchesBefore,
    stripeKeys: keys,
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

interface SentEmail {
  subject: string;
  html: string;
  text: string;
  from: string;
  transport: string;
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
      transport: String(m.__transport ?? ""),
    }));
}

function onlySentSince(mark: number, kind: EmailKind): SentEmail {
  const found = sentSince(mark, kind);
  expect(found, `expected exactly one ${kind} email`).toHaveLength(1);
  return found[0]!;
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

/** GET /api/orders/[id] — what the operator's order page loads. */
async function orderApi(key: OrgKey, orderId: string): Promise<OrderDTO> {
  await actingAs(key);
  return ok<OrderDTO>(await getOrderRoute(buildRequest(`/api/orders/${orderId}`), idParams(orderId)));
}

/** /consent/[token] — the hosted page the email's button opens. */
async function consentPage(token: string): Promise<string> {
  anonymous();
  return renderToStaticMarkup(await ConsentPage({ params: Promise.resolve({ token }) }));
}

/** The customer signs and confirms (GET, then POST /api/consent/[token]). */
async function confirmConsent(token: string, signedName: string): Promise<PublicConsentView> {
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
  return view;
}

/** /pay/success — where Stripe returns the customer (it appends `session_id`). */
async function receiptPage(order: OrderDTO): Promise<string> {
  anonymous();
  return renderToStaticMarkup(
    await PaymentSuccessPage({
      searchParams: Promise.resolve({
        order: order.orderNumber,
        session_id: order.payment.paymentSessionId!,
      }),
    }),
  );
}

/** A completed Stripe Checkout for `order`, as Stripe sends it. */
function checkoutCompleted(order: OrderDTO, amountTotal: number): string {
  return JSON.stringify(
    buildCheckoutCompleted({
      orderId: order.id,
      orderNumber: order.orderNumber,
      sessionId: order.payment.paymentSessionId ?? undefined,
      paymentIntentId: order.payment.paymentIntentId ?? undefined,
      amountTotal,
      customerEmail: order.customer.email,
    }),
  );
}

/** A Stripe delivery to `slug`'s own endpoint, signed with `secret`. Returns
 *  the reply and the secret key of every Stripe client the endpoint asked for
 *  while verifying it. */
async function deliverStripe(slug: string, payload: string, secret: string) {
  anonymous();
  const request = new Request(`http://localhost/api/webhooks/stripe/${slug}`, {
    method: "POST",
    headers: new Headers({
      "content-type": "application/json",
      "stripe-signature": signWebhook(payload, secret),
    }),
    body: payload,
  }) as never;
  const { result: res, keys } = await stripeKeysDuring(() =>
    stripeWebhookRoute(request, { params: Promise.resolve({ orgSlug: slug }) }),
  );
  const reply = await jsonBody<{ ok: boolean; data: Record<string, unknown> } & Partial<ApiError>>(res);
  return { ...reply, stripeKeys: keys };
}

async function storedOrder(orderId: string) {
  const doc = await Order.findById(orderId).lean<{
    organizationId: Types.ObjectId;
    serviceType: string;
    status: string;
    charges: { name: string; amount: number; timing: string }[];
    pricing: { amount: number; currency: string };
    flight?: { airlineFare: number | null } | null;
    payment: {
      gateway?: string | null;
      stripeSessionId?: string | null;
      checkoutUrl?: string | null;
    };
  } | null>();
  expect(doc, `order ${orderId} was not stored`).toBeTruthy();
  return doc!;
}

/** What a refused request must not have written. */
async function writtenCounts() {
  return {
    orders: await Order.countDocuments({}),
    orderCreatedAudits: await AuditLog.countDocuments({ action: AuditAction.ORDER_CREATED }),
    linkAudits: await AuditLog.countDocuments({ action: AuditAction.ORDER_PAYMENT_LINK_REGENERATED }),
    evidence: await OrderEvidence.countDocuments({}),
  };
}

/* ------------------------------------------------------------------ *
 * The orders the forms submit
 * ------------------------------------------------------------------ */

/** The flight form: the airline charge ($400) in its own field, ONE charge
 *  named "Rental Cost" ($100) — all the link may collect. No PNR yet. */
function flightBody() {
  return roundTripFlightInput(
    {
      provider: AIRLINE_KEY,
      charges: [{ name: FLIGHT_CHARGE, amount: 100, timing: PaymentTiming.PREPAID }],
    },
    { airlineFare: 400, pnr: null },
  );
}

/** The car form, unchanged: a prepaid rental line and a deposit due at the
 *  counter. Posts no `serviceType`, exactly as the car form does. */
function carBody() {
  return validCreateOrderInput({
    charges: [
      { name: "Rental cost", amount: 249.99, timing: PaymentTiming.PREPAID },
      { name: "Deposit", amount: 100, timing: PaymentTiming.DUE_AT_COUNTER },
    ],
  });
}

function hotelBody() {
  return validHotelOrderInput({ provider: HOTEL_SUPPLIER_KEY });
}

/* ------------------------------------------------------------------ *
 * The email composer, rendered
 * ------------------------------------------------------------------ */

type Rtl = typeof import("@testing-library/react");

/** Globals the jsdom environment sets on `globalThis` and does not take back
 *  on teardown (it restores only what it records as overridden). */
const LEFT_BEHIND = ["window", "self", "top", "parent", "IS_REACT_ACT_ENVIRONMENT"];

/** Let React's scheduler run out. A commit made outside `act` (the composer
 *  re-rendering once its fetch answers) queues its passive-effect flush as a
 *  scheduler task that reads `window.event`; it must run while the browser
 *  is still installed. */
async function settleReact() {
  for (let i = 0; i < 5; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Run `fn` in a browser: Vitest's own jsdom environment, installed on this
 * node process for the duration of `fn` and taken down after, so every
 * server-side call in this file runs outside it. Testing Library is loaded
 * inside, as the component tests load it.
 */
async function inBrowser<T>(fn: (rtl: Rtl) => Promise<T>): Promise<T> {
  const g = globalThis as Record<string, unknown>;
  const saved = LEFT_BEHIND.map((k) => [k, Object.getOwnPropertyDescriptor(g, k)] as const);
  const { builtinEnvironments } = await import("vitest/environments");
  const browser = await builtinEnvironments.jsdom.setup(globalThis, {
    jsdom: { url: "http://localhost:3000/app/orders" },
  });
  let rtl: Rtl | null = null;
  try {
    rtl = await import("@testing-library/react");
    return await fn(rtl);
  } finally {
    await settleReact();
    rtl?.cleanup();
    await settleReact();
    await browser.teardown(globalThis);
    for (const [k, descriptor] of saved) {
      if (descriptor) Object.defineProperty(g, k, descriptor);
      else delete g[k];
    }
  }
}

interface ComposerGateway {
  /** Every URL the composer GETs. */
  requested: string[];
  /** The gateway selector's options as rendered, or null when the field
   *  shows a fixed label instead. */
  options: { value: string; label: string; selected: boolean }[] | null;
  /** The fixed label the field shows when there is nothing to choose. */
  fixed: string | null;
  /** The selector's value after any choice the test made. */
  chosen: string | null;
  /** Every body the composer POSTed to generate-payment-link. */
  generated: unknown[];
}

/**
 * Render the email composer for `order` exactly as the order's email screen
 * mounts it, its fetch answered with `organizationsJson` — the REAL
 * GET /api/organizations reply captured above — and read its "Payment
 * gateway" field. Optionally pick a gateway, and click "Generate payment
 * link" to record what the composer posts (that request is never answered
 * here; the tests replay it against the real route).
 */
async function composerGateway(
  order: OrderDTO,
  organizationsJson: string,
  action: { choose?: PaymentGatewayKey; generate?: boolean } = {},
): Promise<ComposerGateway> {
  return inBrowser(async ({ render, waitFor, fireEvent, within }) => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    const g = globalThis as { fetch: typeof fetch };
    const nodeFetch = g.fetch;
    g.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({
        url,
        method,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      if (method === "GET" && url === "/api/organizations") {
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => organizationsJson,
        } as unknown as Response);
      }
      // The live preview and the link request: recorded, never answered.
      return new Promise<Response>(() => {});
    }) as typeof fetch;
    try {
      const view = render(
        createElement(
          QueryClientProvider,
          { client: new QueryClient() },
          createElement(
            ActivityFeedProvider,
            null,
            createElement(EmailComposer, {
              order,
              initialHtml: "<p>Preview</p>",
              defaultSubject: `Payment request • ${order.orderNumber}`,
            }),
          ),
        ),
      );
      const field = (): HTMLElement => {
        const label = within(view.container).getByText("Payment gateway").closest("label");
        if (!label) throw new Error("the composer has no Payment gateway field");
        return label;
      };
      await waitFor(() => expect(field().textContent ?? "").not.toContain("Loading…"));
      const select = field().querySelector("select");
      const options = select
        ? Array.from(select.options).map((o) => ({
            value: o.value,
            label: o.textContent ?? "",
            selected: o.selected,
          }))
        : null;
      const fixed = select ? null : (field().textContent ?? "").replace("Payment gateway", "").trim();
      if (action.choose) {
        if (!select) throw new Error("the composer offers no gateway to choose");
        fireEvent.change(select, { target: { value: action.choose } });
      }
      const chosen = field().querySelector("select")?.value ?? null;
      if (action.generate) {
        const button = within(view.container).getByText("Generate payment link").closest("button");
        if (!button) throw new Error("the composer has no Generate payment link button");
        fireEvent.click(button);
      }
      return {
        requested: calls.filter((c) => c.method === "GET").map((c) => c.url),
        options,
        fixed,
        chosen,
        generated: calls
          .filter((c) => c.method === "POST" && c.url === `/api/orders/${order.id}/generate-payment-link`)
          .map((c) => c.body),
      };
    } finally {
      g.fetch = nodeFetch;
    }
  });
}

const PAYPAL_AND_STRIPE = [
  { value: PaymentGatewayKey.PAYPAL, label: "PayPal", selected: true },
  { value: PaymentGatewayKey.STRIPE, label: "Stripe", selected: false },
];

/* ================================================================== *
 * 1. ENABLED
 * ================================================================== */

describe("1. ENABLED — Stripe is enabled for TripReservations through the existing configuration, PayPal preserved", () => {
  it("1. stored payments read provider PAYPAL + enabledProviders [PAYPAL, STRIPE] — the ONLY change from production's PayPal-only document, its keys in env and nowhere in Mongo; GET /api/organizations (what the composer reads) returns exactly that for TripReservations, and every other brand's payments as they were", async () => {
    const trip = await rawOrg("trip");
    expect(trip.payments).toMatchObject({
      provider: PaymentGatewayKey.PAYPAL,
      enabledProviders: [PaymentGatewayKey.PAYPAL, PaymentGatewayKey.STRIPE],
    });
    expect(trip.payments).not.toHaveProperty("captureMode");
    expect(trip.serviceTypes).toEqual([ServiceType.CAR_RENTAL, ServiceType.FLIGHT]);

    // The enablement is that one field: everything else is the document
    // production has today, field for field.
    const { payments: paymentsBefore, ...restBefore } = tripAsInProduction;
    const { payments: paymentsAfter, ...restAfter } = trip;
    expect((paymentsBefore as { provider: string; enabledProviders: string[] })).toMatchObject({
      provider: PaymentGatewayKey.PAYPAL,
      enabledProviders: [PaymentGatewayKey.PAYPAL],
    });
    expect(paymentsAfter).toEqual({
      ...(paymentsBefore as Record<string, unknown>),
      enabledProviders: [PaymentGatewayKey.PAYPAL, PaymentGatewayKey.STRIPE],
    });
    expect(restAfter).toEqual(restBefore);

    // Its Stripe credentials are env-only: nothing in the vault, nothing on
    // the document.
    expect(await OrganizationCredential.countDocuments({ organizationId: orgIds.trip })).toBe(0);
    for (const secret of [TRIP_STRIPE_SECRET_KEY, TRIP_STRIPE_WEBHOOK_SECRET]) {
      expect(JSON.stringify(trip)).not.toContain(secret);
    }

    // What the email composer reads, for TripReservations: exactly that.
    const api = await organizationsApi("trip");
    expect(api.data.selectedId).toBe(String(orgIds.trip));
    expect(api.data.payments).toEqual({
      provider: PaymentGatewayKey.PAYPAL,
      enabledProviders: [PaymentGatewayKey.PAYPAL, PaymentGatewayKey.STRIPE],
      captureMode: CaptureMode.AUTOMATIC,
    });
    expect(api.data.serviceTypes).toEqual([ServiceType.CAR_RENTAL, ServiceType.FLIGHT]);
    for (const secret of [TRIP_STRIPE_SECRET_KEY, TRIP_STRIPE_WEBHOOK_SECRET]) {
      expect(api.text).not.toContain(secret);
    }

    // Every other brand reads what it always read — Stripe is not enabled
    // for everyone.
    expect((await organizationsApi("rc")).data.payments).toEqual({
      provider: PaymentGatewayKey.STRIPE,
      enabledProviders: [PaymentGatewayKey.STRIPE],
      captureMode: CaptureMode.AUTOMATIC,
    });
    expect((await organizationsApi("gv")).data.payments).toEqual({
      provider: PaymentGatewayKey.STRIPE,
      enabledProviders: [PaymentGatewayKey.STRIPE],
      captureMode: CaptureMode.MANUAL,
    });
    expect((await organizationsApi("coast")).data.payments).toEqual({
      provider: PaymentGatewayKey.PAYPAL,
      enabledProviders: [PaymentGatewayKey.PAYPAL],
      captureMode: CaptureMode.AUTOMATIC,
    });

    // The resolver behind the link: PayPal by default, Stripe on request —
    // a gateway of TripReservations' own, never the deployment's registry
    // Stripe (which is RentalConfirmation's).
    expect((await getGatewayForOrganization(String(orgIds.trip))).key).toBe(PaymentGatewayKey.PAYPAL);
    const tripStripe = await getGatewayForOrganization(String(orgIds.trip), PaymentGatewayKey.STRIPE);
    expect(tripStripe.key).toBe(PaymentGatewayKey.STRIPE);
    expect(tripStripe.enabled).toBe(true);
    expect(tripStripe).not.toBe(getDefaultGateway());
    // The PayPal-only brand asking for Stripe still resolves PayPal.
    expect(
      (await getGatewayForOrganization(String(orgIds.coast), PaymentGatewayKey.STRIPE)).key,
    ).toBe(PaymentGatewayKey.PAYPAL);
  });
});

/* ================================================================== *
 * 2. ADMIN UI
 * ================================================================== */

describe("2. ADMIN UI — the email composer offers Stripe to TripReservations, and only to it", () => {
  it("2. the composer, its fetch answered with the real GET /api/organizations payload: TripReservations' 'Payment gateway' offers PayPal and Stripe with PayPal preselected — left alone it posts {gateway: PAYPAL}, switched it posts {gateway: STRIPE}, which the real route turns into a Stripe session; the PayPal-only brand shows a fixed 'PayPal' and posts {}; once linked on Stripe the field locks to 'Stripe'", async () => {
    const tripOrder = await submitOrder("trip", flightBody());
    const coastOrder = await submitOrder("coast", carBody());
    const tripApi = await organizationsApi("trip");
    const coastApi = await organizationsApi("coast");
    anonymous();

    // TripReservations: a real choice, PayPal preselected (its default).
    const leftAlone = await composerGateway(tripOrder, tripApi.text, { generate: true });
    expect(leftAlone.requested).toContain("/api/organizations");
    expect(leftAlone.options).toEqual(PAYPAL_AND_STRIPE);
    expect(leftAlone.fixed).toBeNull();
    expect(leftAlone.chosen).toBe(PaymentGatewayKey.PAYPAL);
    expect(leftAlone.generated).toEqual([{ gateway: PaymentGatewayKey.PAYPAL }]);

    const switched = await composerGateway(tripOrder, tripApi.text, {
      choose: PaymentGatewayKey.STRIPE,
      generate: true,
    });
    expect(switched.options).toEqual(PAYPAL_AND_STRIPE);
    expect(switched.chosen).toBe(PaymentGatewayKey.STRIPE);
    expect(switched.generated).toEqual([{ gateway: PaymentGatewayKey.STRIPE }]);

    // The PayPal-only brand: nothing to choose, no gateway posted.
    const paypalOnly = await composerGateway(coastOrder, coastApi.text, { generate: true });
    expect(paypalOnly.requested).toContain("/api/organizations");
    expect(paypalOnly.options).toBeNull();
    expect(paypalOnly.fixed).toBe("PayPal");
    expect(paypalOnly.generated).toEqual([{}]);

    // What the server does with exactly those bodies.
    const onStripe = await generateLink(
      "trip",
      tripOrder.id,
      switched.generated[0] as Record<string, unknown>,
    );
    expect(onStripe.status, JSON.stringify(onStripe.json)).toBe(200);
    expect(onStripe.order!.payment.gateway).toBe(PaymentGatewayKey.STRIPE);
    expect(onStripe.stripe).toHaveLength(1);
    expect(onStripe.paypal).toHaveLength(0);
    expect(onStripe.stripeKeys).toEqual([TRIP_STRIPE_SECRET_KEY]);
    const onPayPal = await generateLink(
      "coast",
      coastOrder.id,
      paypalOnly.generated[0] as Record<string, unknown>,
    );
    expect(onPayPal.status, JSON.stringify(onPayPal.json)).toBe(200);
    expect(onPayPal.order!.payment.gateway).toBe(PaymentGatewayKey.PAYPAL);
    expect(onPayPal.stripe).toHaveLength(0);
    expect(onPayPal.paypal).toHaveLength(1);
    anonymous();

    // Linked on Stripe: the field locks and names what was used.
    const locked = await composerGateway(onStripe.order!, tripApi.text);
    expect(locked.options).toBeNull();
    expect(locked.fixed).toBe("Stripe");
  }, 60_000);
});

/* ================================================================== *
 * 3–5. TRIPRESERVATIONS FLIGHT ON STRIPE
 * ================================================================== */

/** A TripReservations flight linked on Stripe (as the composer posts it),
 *  previewed and sent. */
async function startTripFlightOnStripe() {
  const created = await submitOrder("trip", flightBody());
  const link = await generateLink("trip", created.id, { gateway: PaymentGatewayKey.STRIPE });
  expect(link.status, JSON.stringify(link.json)).toBe(200);
  const order = link.order!;
  const preview = await composerPreview("trip", created.id);
  const request = await sendRequest("trip", created.id);
  return {
    created,
    link,
    order,
    preview,
    request,
    due: formatEmailDate(order.payment.expiresAt!),
  };
}

describe("3–5. TRIPRESERVATIONS FLIGHT ON STRIPE — Airline Charge $400 + 'Rental Cost' $100", () => {
  it("3. the link generated with gateway STRIPE is ONE Stripe Checkout session on TripReservations' OWN secret key (never the deployment's): unit_amount 10000 and no 400 / 500 / 40000 / 50000 anywhere in its params, the line item led by 'Rental Cost • ', automatic capture, Trip Reservations as merchant; no PayPal order — no PayPal request at all", async () => {
    const created = await submitOrder("trip", flightBody());
    const stored = await storedOrder(created.id);
    expect(stored.serviceType).toBe(ServiceType.FLIGHT);
    expect(String(stored.organizationId)).toBe(String(orgIds.trip));
    expect(stored.charges).toEqual([{ name: FLIGHT_CHARGE, amount: 100, timing: PaymentTiming.PREPAID }]);
    expect(stored.flight!.airlineFare).toBe(400);
    expect(stored.pricing).toEqual({ amount: 100, currency: "USD" });

    const link = await generateLink("trip", created.id, { gateway: PaymentGatewayKey.STRIPE });
    expect(link.status, JSON.stringify(link.json)).toBe(200);

    // TripReservations' own Stripe account — the deployment key never asked for.
    expect(TRIP_STRIPE_SECRET_KEY).not.toBe(env.server.STRIPE_SECRET_KEY);
    expect(link.stripeKeys).toEqual([TRIP_STRIPE_SECRET_KEY]);
    expect(link.stripeKeys).not.toContain(env.server.STRIPE_SECRET_KEY);

    // PayPal: untouched.
    expect(link.paypal).toHaveLength(0);
    expect(link.paypalFetches).toBe(0);

    // ONE session, collecting the named charge alone.
    expect(link.sessions).toHaveLength(1);
    const { params, options, result, manualCapture } = link.sessions[0]!;
    const items = params.line_items ?? [];
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.quantity).toBe(1);
    expect(item.price_data!.unit_amount).toBe(10000);
    expect(item.price_data!.currency).toBe("usd");
    expect(amountsIn(params)).toEqual([10000]);
    expectNoFigures("TripReservations' Stripe session", params, ["400", "500", "40000", "50000"]);
    expect(JSON.stringify(params)).not.toContain("Airline Charge");
    const product = item.price_data!.product_data!;
    expect(product.name.startsWith(`${FLIGHT_CHARGE} • `), product.name).toBe(true);
    expect(product.name).toBe(`${FLIGHT_CHARGE} • ${AIRLINE} • ${OUTBOUND} (round trip)`);
    expect(product.description).toBe(`${FLIGHT_CHARGE} • ${DEPARTS_RETURNS}`);
    // Automatic capture (TripReservations stores no capture mode), Trip
    // Reservations named as the merchant — the whole request, pinned.
    expect(manualCapture).toBe(false);
    expect(params.payment_intent_data?.capture_method).toBeUndefined();
    expect(normalise(params, idsOf(created))).toEqual(tripFlightSessionExpectation());
    expect(options).toEqual({ idempotencyKey: `order:${created.id}:checkout` });

    // The order is pinned to that session.
    const linked = link.order!;
    expect(linked.status).toBe(OrderStatus.LINK_GENERATED);
    expect(linked.payment.gateway).toBe(PaymentGatewayKey.STRIPE);
    expect(linked.payment.paymentSessionId).toBe(result.id);
    expect(linked.payment.paymentUrl).toBe(result.url);
    expect(linked.payment.capture ?? null).toBeNull();
  }, 60_000);

  it("4. the payment request names Stripe — 'Payment processed securely via Stripe' and 'Powered by Stripe.', never PayPal — and shows Airline Charge $400.00 / Rental Cost $100.00 / Total Booking Value $500.00 / Amount Payable Now $100.00 with 'Review & pay $100.00 Rental Cost'; the consent page continues to Trip Reservations' secure Stripe checkout; once confirmed the button reads 'Pay the $100.00 Rental Cost securely with Stripe →'", async () => {
    const j = await startTripFlightOnStripe();
    const on = j.created.orderNumber;
    const { email } = j.request;

    expect(email.subject).toBe(`Complete your ${FLIGHT_CHARGE} payment • ${on}`);
    const rows = `Price breakdown ${emailMoney(FLIGHT_CHARGE, "Amount Payable Now")}`;
    expect(moneyBlock(j.preview), "composer preview").toBe(rows);
    expect(moneyBlock(email.html), "payment request as sent").toBe(rows);
    expect(plainText(email.text)).toContain(emailMoney(FLIGHT_CHARGE, "Amount Payable Now"));

    for (const [where, html] of Object.entries({ "composer preview": j.preview, "payment request": email.html })) {
      const read = visibleText(html);
      // The CTA names the charge — never the airline, never a total.
      expect(read, where).toContain(
        `Amount Payable Now $100.00 ${FLIGHT_CHARGE} Order ${on} Due ${j.due} Review & pay $100.00 ${FLIGHT_CHARGE}`,
      );
      expect(read, where).not.toContain("Amount Payable Now $400.00");
      expect(read, where).not.toContain("Amount Payable Now $500.00");
      // Stripe named as the processor — and PayPal nowhere.
      expect(read, where).toContain(
        "Payment processed securely via Stripe. Your card details are encrypted end-to-end",
      );
      expect(read, where).toContain("Powered by Stripe.");
      expect(read, where).toContain(`${TRIP.brandName} Payment requested`);
      expect(html, where).toContain(`mailto:${TRIP.supportEmail}`);
    }
    expect(plainText(email.text)).toContain("Payment processed securely via Stripe.");
    for (const [where, content] of Object.entries({
      "composer preview": j.preview,
      "payment request (html)": email.html,
      "payment request (text)": email.text,
      "payment request (subject)": email.subject,
    })) {
      expect(everything(content), `${where} names PayPal`).not.toMatch(/paypal/i);
    }
    // Trip Reservations' own sender, over its own transport.
    expect(email.from).toBe(`${TRIP.brandName} <${TRIP.fromEmail}>`);
    expect(email.transport).toBe(`org:${TRIP.fromEmail}`);

    // The consent page the email's button opens: Stripe checkout.
    const consent = await consentPage(j.request.consentToken);
    const page = visibleText(consent);
    expect(page).toContain(`you'll continue to ${TRIP.brandName}'s secure Stripe checkout.`);
    expect(page).toContain("You'll be taken directly to Stripe Checkout to complete payment.");
    expect(moneyBlock(consent, "Booking summary")).toBe(
      `Booking summary Amount Payable Now $100.00 ${FLIGHT_CHARGE} New booking ${pageMoney(FLIGHT_CHARGE, "Amount Payable Now")}`,
    );
    expect(page).toContain(`Confirm & pay $100.00 ${FLIGHT_CHARGE}`);
    expect(page).toContain(`Email ${TRIP.supportEmail} if you need help.`);
    expect(everything(consent), "the consent page names PayPal").not.toMatch(/paypal/i);

    // The customer confirms: the page's payment link is the Stripe session's.
    const view = await confirmConsent(j.request.consentToken, j.created.customer.name);
    expect(view.brandName).toBe(TRIP.brandName);
    expect(view.gatewayLabel).toBe("Stripe");
    expect(view.paymentUrl).toBe(j.order.payment.paymentUrl);
    expect(view.paymentUrl).toContain(`/pay/checkout/${j.order.payment.paymentSessionId}`);

    // Consented: the composer's pay button names Stripe and the charge.
    const afterConsent = visibleText(await composerPreview("trip", j.created.id));
    expect(afterConsent).toContain(`Pay the $100.00 ${FLIGHT_CHARGE} securely with Stripe →`);
    expect(afterConsent).toContain("You already confirmed this booking — this opens Stripe Checkout.");
    expect(afterConsent).not.toMatch(/paypal/i);

    expect(paypalFetches, "PayPal was asked for something").toBe(0);
  }, 60_000);

  it("5. a checkout.session.completed to /api/webhooks/stripe/tripreservations signed with the DEPLOYMENT secret is refused (400) and settles nothing; signed with TripReservations' own webhook secret it is verified on its own account, marks the order PAID ($100.00 received) and the confirmation follows — 'Rental Cost Paid $100.00', 'Payment processed securely by Stripe' — as does the receipt page", async () => {
    const j = await startTripFlightOnStripe();
    await confirmConsent(j.request.consentToken, j.created.customer.name);
    const on = j.created.orderNumber;
    const payload = checkoutCompleted(j.order, 10000);

    // Signed with the deployment's secret: not TripReservations' account.
    const forged = await deliverStripe(TRIP.slug, payload, env.server.STRIPE_WEBHOOK_SECRET);
    expect(forged.status, JSON.stringify(forged.body)).toBe(400);
    expect((await storedOrder(j.created.id)).status).not.toBe(OrderStatus.PAID);

    // Signed with TripReservations' own webhook secret.
    const delivered = await deliverStripe(TRIP.slug, payload, TRIP_STRIPE_WEBHOOK_SECRET);
    expect(delivered.status, JSON.stringify(delivered.body)).toBe(200);
    expect(delivered.body.data).toMatchObject({ received: true, handled: true, duplicate: false });
    // Verified with TripReservations' Stripe client, not the deployment's.
    expect(delivered.stripeKeys).toEqual([TRIP_STRIPE_SECRET_KEY]);

    const paid = await orderApi("trip", j.created.id);
    expect(paid.status).toBe(OrderStatus.PAID);
    expect(paid.payment.gateway).toBe(PaymentGatewayKey.STRIPE);
    expect(paid.payment.amountReceived).toBe(100);
    expect(paid.payment.paidAt).toBeTruthy();

    // The outbox sends the confirmation.
    anonymous();
    const mark = sentMail.length;
    const drained = await drainPendingEmails(10);
    expect(drained.sent).toBe(1);
    const confirmation = onlySentSince(mark, EmailKind.PAYMENT_CONFIRMATION);
    const read = visibleText(confirmation.html);
    expect(confirmation.subject).toBe(`${AIRLINE} booking confirmed • ${on}`);
    expect(moneyBlock(confirmation.html)).toBe(
      `Price breakdown ${emailMoney(FLIGHT_CHARGE, `${FLIGHT_CHARGE} Paid`)}`,
    );
    expect(read).toContain(`${FLIGHT_CHARGE} Paid $100.00`);
    expect(read).toContain(`${FLIGHT_CHARGE} Paid $100.00 Order ${on}`);
    expect(read).toContain(`We've received your ${FLIGHT_CHARGE} payment for new booking`);
    expect(plainText(confirmation.text)).toContain(emailMoney(FLIGHT_CHARGE, `${FLIGHT_CHARGE} Paid`));
    expect(read).toContain(`${TRIP.brandName} Payment receipt Payment confirmed`);
    expect(read).toContain("Payment processed securely by Stripe — PCI-DSS Level 1 certified.");
    expect(everything(confirmation.html), "the confirmation names PayPal").not.toMatch(/paypal/i);
    expect(everything(confirmation.text), "the confirmation's text names PayPal").not.toMatch(/paypal/i);
    expect(confirmation.from).toBe(`${TRIP.brandName} <${TRIP.fromEmail}>`);
    expect(confirmation.transport).toBe(`org:${TRIP.fromEmail}`);

    // Where Stripe returns the customer: the same name, money and processor.
    const receipt = await receiptPage(paid);
    expect(moneyBlock(receipt)).toBe(`Price breakdown ${pageMoney(FLIGHT_CHARGE, `${FLIGHT_CHARGE} Paid`)}`);
    expect(visibleText(receipt)).toContain("Payment processed securely by Stripe — PCI-DSS Level 1 certified.");
    expect(everything(receipt), "the receipt names PayPal").not.toMatch(/paypal/i);

    // PayPal never took part, from link to receipt.
    expect(paypalFetches, "PayPal was asked for something").toBe(0);
  }, 60_000);
});

/* ================================================================== *
 * 6. TRIPRESERVATIONS CAR ON STRIPE
 * ================================================================== */

describe("6. TRIPRESERVATIONS CAR ON STRIPE — the car rental is the car rental, whichever gateway", () => {
  it("6. a car rental (Rental cost $249.99 prepaid + Deposit $100.00 at the counter) linked on Stripe: unit_amount 24999 only, on TripReservations' own key; the line item exactly every car's ('Budget • Toyota Camry rental', the pick-up / drop-off line — RentalConfirmation's payload with only the merchant's name changed); the request is the car email (car breakdown, 'Review & Confirm Booking') naming Stripe — no flight row anywhere", async () => {
    const created = await submitOrder("trip", carBody());
    const stored = await storedOrder(created.id);
    expect(created.serviceType).toBe(ServiceType.CAR_RENTAL);
    expect(stored.flight ?? null).toBeNull();
    expect(stored.charges).toEqual([
      { name: "Rental cost", amount: 249.99, timing: PaymentTiming.PREPAID },
      { name: "Deposit", amount: 100, timing: PaymentTiming.DUE_AT_COUNTER },
    ]);
    expect(stored.pricing).toEqual({ amount: 249.99, currency: "USD" });

    const link = await generateLink("trip", created.id, { gateway: PaymentGatewayKey.STRIPE });
    expect(link.status, JSON.stringify(link.json)).toBe(200);
    expect(link.order!.payment.gateway).toBe(PaymentGatewayKey.STRIPE);
    expect(link.stripeKeys).toEqual([TRIP_STRIPE_SECRET_KEY]);
    expect(link.paypal).toHaveLength(0);
    expect(link.paypalFetches).toBe(0);
    expect(link.sessions).toHaveLength(1);
    const { params, options } = link.sessions[0]!;
    // The prepaid amount only — never the deposit, never the total.
    expect(params.line_items).toHaveLength(1);
    expect(params.line_items![0]!.price_data!.unit_amount).toBe(24999);
    expect(amountsIn(params)).toEqual([24999]);
    expectNoFigures("TripReservations' car session", params, ["100", "10000", "349.99", "34999"]);
    // The car line item format, unchanged: the characterization payload,
    // only the merchant's name being Trip Reservations.
    expect(params.line_items![0]!.price_data!.product_data!.name).toBe(`${CAR_SUPPLIER} • Toyota Camry rental`);
    expect(params.line_items![0]!.price_data!.product_data!.description).toMatch(
      /^Pick-up: \d{4}-\d{2}-\d{2} \(LAX Airport — Terminal 1\) • Drop-off: \d{4}-\d{2}-\d{2} \(San Diego Downtown\)$/,
    );
    expect(normalise(params, idsOf(created))).toEqual(carSessionExpectation(TRIP.brandName));
    expect(params.payment_intent_data?.capture_method).toBeUndefined();
    expect(options).toEqual({ idempotencyKey: `order:${created.id}:checkout` });

    // The car email, as it always was — naming Stripe.
    const preview = await composerPreview("trip", created.id);
    const { email } = await sendRequest("trip", created.id);
    const on = created.orderNumber;
    expect(email.subject).toBe(`Complete your ${CAR_SUPPLIER} payment • ${on}`);
    for (const [where, html] of Object.entries({ "composer preview": preview, "payment request": email.html })) {
      const read = visibleText(html);
      expect(read, where).toContain(CAR_ROWS);
      expect(read, where).toContain(`You pay today $249.99 Order ${on}`);
      expect(read, where).toContain("Review & Confirm Booking");
      expect(read, where).toContain(
        `Booking details Type New booking Provider ${CAR_SUPPLIER} Vehicle Toyota • Camry Pick-up`,
      );
      expect(read, where).toContain(
        `Thanks for booking with ${CAR_SUPPLIER}. Your new booking is reserved — please complete payment using the secure link below to confirm it.`,
      );
      expect(read, where).toContain(`${TRIP.brandName} Payment requested`);
      expect(read, where).toContain(
        "Payment processed securely via Stripe. Your card details are encrypted end-to-end",
      );
      expect(everything(html), `${where} names PayPal`).not.toMatch(/paypal/i);
    }
    expect(email.transport).toBe(`org:${TRIP.fromEmail}`);
    // No flight row, word or reference on any part of it.
    for (const [where, content] of Object.entries({
      "composer preview": preview,
      "payment request (html)": email.html,
      "payment request (text)": email.text,
      "payment request (subject)": email.subject,
    })) {
      const read = [visibleText(content), plainText(decoded(content))].join("\n");
      for (const phrase of FLIGHT_PHRASES) {
        expect(read, `${where} shows "${phrase}"`).not.toContain(phrase);
      }
      expect(read, `${where} shows a PNR`).not.toMatch(/\bPNR\b/);
      expect(read, `${where} shows the airline`).not.toContain(AIRLINE);
    }
  }, 60_000);
});

/* ================================================================== *
 * 7. DEFAULT PRESERVED
 * ================================================================== */

describe("7. DEFAULT PRESERVED — PayPal stays TripReservations' default, and no service changes", () => {
  it("7a. with NO gateway choice (the bare body) — and with the composer's preselected {gateway: PAYPAL} — TripReservations' links are PayPal orders on its own PayPal account ('100.00' / '249.99'), never a Stripe session: no Stripe client is even requested; the request then names PayPal, not Stripe", async () => {
    const flight = await submitOrder("trip", flightBody());
    const bare = await generateLink("trip", flight.id, {});
    expect(bare.status, JSON.stringify(bare.json)).toBe(200);
    expect(bare.order!.payment.gateway).toBe(PaymentGatewayKey.PAYPAL);
    expect(bare.sessions).toHaveLength(0);
    expect(bare.stripeKeys).toEqual([]);
    expect(bare.paypal).toHaveLength(1);
    const unit = bare.paypal[0]!.purchase_units[0]!;
    expect(unit.amount).toEqual({ currency_code: "USD", value: "100.00" });
    expect(amountsIn(bare.paypal[0])).toEqual([{ currency_code: "USD", value: "100.00" }]);
    expect(unit.description).toBe(`${FLIGHT_CHARGE} • ${DEPARTS_RETURNS}`);
    expect(unit.custom_id).toBe(flight.id);
    expect(bare.paypal[0]!.payment_source.paypal.experience_context.brand_name).toBe(TRIP.brandName);

    const car = await submitOrder("trip", carBody());
    const preselected = await generateLink("trip", car.id, { gateway: PaymentGatewayKey.PAYPAL });
    expect(preselected.status, JSON.stringify(preselected.json)).toBe(200);
    expect(preselected.order!.payment.gateway).toBe(PaymentGatewayKey.PAYPAL);
    expect(preselected.sessions).toHaveLength(0);
    expect(preselected.stripeKeys).toEqual([]);
    expect(preselected.paypal).toHaveLength(1);
    expect(preselected.paypal[0]!.purchase_units[0]!.amount).toEqual({ currency_code: "USD", value: "249.99" });

    // TripReservations' own PayPal account, and nothing reached Stripe.
    expect(paypalClientIds).toEqual(["tripreservations-client-id"]);
    expect(getCurrentTestStripe().sessionsCreated).toHaveLength(0);

    // The payment request follows the order's gateway: PayPal.
    const preview = await composerPreview("trip", flight.id);
    expect(visibleText(preview)).toContain(
      "Payment processed securely via PayPal. Your card details are encrypted end-to-end",
    );
    expect(visibleText(preview)).toContain("Powered by PayPal.");
    expect(everything(preview), "the PayPal request names Stripe").not.toMatch(/stripe/i);
  }, 60_000);

  it("7b. Stripe enablement changes no service: TripReservations still sells exactly [CAR_RENTAL, FLIGHT] (stored, and in GET /api/organizations) — a HOTEL order is refused (422 'Trip Reservations does not sell hotel stays…') and writes nothing, while globevista still books its hotel", async () => {
    expect(tripAsInProduction.serviceTypes).toEqual([ServiceType.CAR_RENTAL, ServiceType.FLIGHT]);
    expect((await rawOrg("trip")).serviceTypes).toEqual([ServiceType.CAR_RENTAL, ServiceType.FLIGHT]);
    expect((await organizationsApi("trip")).data.serviceTypes).toEqual([
      ServiceType.CAR_RENTAL,
      ServiceType.FLIGHT,
    ]);

    const before = await writtenCounts();
    const hotel = await postOrder("trip", hotelBody());
    expect(hotel.status, JSON.stringify(hotel.body)).toBe(422);
    expect(hotel.body.error).toMatchObject({ code: "VALIDATION_ERROR", message: NOT_SOLD_HOTEL });
    expect(await writtenCounts()).toEqual(before);
    expect(before.orders).toBe(0);

    // A hotel is refused for TripReservations' services, not for everyone.
    const gvHotel = await submitOrder("gv", hotelBody());
    expect(gvHotel.serviceType).toBe(ServiceType.HOTEL);
  }, 60_000);
});

/* ================================================================== *
 * 8. OTHER ORGANIZATIONS
 * ================================================================== */

describe("8. OTHER ORGANIZATIONS — enabling Stripe for TripReservations changes nobody else", () => {
  it("8a. rentalconfirmation (default, Stripe): its car link still runs on the DEPLOYMENT key path — the deployment STRIPE_SECRET_KEY, the registry's default gateway, automatic capture — and is byte-for-byte the characterization payload ('Budget • Toyota Camry rental', 24999); asked for PAYPAL, which it never enabled, it is still that Stripe session", async () => {
    // The deployment-key path, by construction: no vault credentials, and the
    // resolver hands back the registry's env-backed default gateway.
    expect(await OrganizationCredential.countDocuments({ organizationId: orgIds.rc })).toBe(0);
    expect(await getGatewayForOrganization(String(orgIds.rc))).toBe(getDefaultGateway());

    const created = await submitOrder("rc", carBody());
    const link = await generateLink("rc", created.id, {});
    expect(link.status, JSON.stringify(link.json)).toBe(200);
    expect(link.order!.payment.gateway).toBe(PaymentGatewayKey.STRIPE);
    expect(link.stripeKeys).toEqual([env.server.STRIPE_SECRET_KEY]);
    expect(link.stripeKeys).not.toContain(TRIP_STRIPE_SECRET_KEY);
    expect(link.sessions).toHaveLength(1);
    expect(normalise(link.sessions[0]!.params, idsOf(created))).toEqual(
      carSessionExpectation(RC.brandName),
    );
    expect(link.sessions[0]!.options).toEqual({ idempotencyKey: `order:${created.id}:checkout` });
    expect(link.sessions[0]!.params.payment_intent_data?.capture_method).toBeUndefined();
    expect(link.paypal).toHaveLength(0);
    expect(link.paypalFetches).toBe(0);

    const another = await submitOrder("rc", carBody());
    const askedPayPal = await generateLink("rc", another.id, { gateway: PaymentGatewayKey.PAYPAL });
    expect(askedPayPal.status, JSON.stringify(askedPayPal.json)).toBe(200);
    expect(askedPayPal.order!.payment.gateway).toBe(PaymentGatewayKey.STRIPE);
    expect(askedPayPal.stripeKeys).toEqual([env.server.STRIPE_SECRET_KEY]);
    expect(askedPayPal.sessions).toHaveLength(1);
    expect(normalise(askedPayPal.stripe[0], idsOf(another))).toEqual(carSessionExpectation(RC.brandName));
    expect(askedPayPal.paypalFetches).toBe(0);

    expect((await rawOrg("rc")).payments).toMatchObject({
      provider: PaymentGatewayKey.STRIPE,
      enabledProviders: [PaymentGatewayKey.STRIPE],
    });
  }, 60_000);

  it("8b. globevista (FlightBizz): still its OWN key (ORG_GLOBEVISTA_STRIPE_SECRET_KEY) and MANUAL capture — capture_method 'manual', the manual idempotency key, the $100 charge alone (unit_amount 10000), the order awaiting authorization", async () => {
    const created = await submitOrder("gv", flightBody());
    const link = await generateLink("gv", created.id, {});
    expect(link.status, JSON.stringify(link.json)).toBe(200);
    expect(link.order!.payment.gateway).toBe(PaymentGatewayKey.STRIPE);
    expect(link.stripeKeys).toEqual([GV_STRIPE_SECRET_KEY]);
    expect(link.sessions).toHaveLength(1);
    const { params, options, manualCapture } = link.sessions[0]!;
    expect(manualCapture).toBe(true);
    expect(params.payment_intent_data?.capture_method).toBe("manual");
    expect(options).toEqual({ idempotencyKey: `order:${created.id}:checkout:manual` });
    expect(params.line_items![0]!.price_data!.unit_amount).toBe(10000);
    expect(amountsIn(params)).toEqual([10000]);
    expectNoFigures("FlightBizz's Stripe session", params, ["400", "500", "40000", "50000"]);
    expect(params.metadata?.appName).toBe(GV.brandName);
    expect(params.payment_intent_data?.description).toBe(`${GV.brandName} • ${created.orderNumber}`);
    expect(link.order!.payment.capture).toMatchObject({
      method: CaptureMode.MANUAL,
      status: PaymentCaptureStatus.PENDING_AUTHORIZATION,
    });
    expect(link.paypal).toHaveLength(0);
    expect(link.paypalFetches).toBe(0);

    expect((await rawOrg("gv")).payments).toMatchObject({
      provider: PaymentGatewayKey.STRIPE,
      enabledProviders: [PaymentGatewayKey.STRIPE],
      captureMode: CaptureMode.MANUAL,
    });
  }, 60_000);

  it("8c. the PayPal-only brand asking for STRIPE gets PayPal — the override is not honoured — on its own PayPal account, never a Stripe session (no Stripe client requested); its Stripe endpoint answers the flat 404 of a brand without Stripe", async () => {
    const created = await submitOrder("coast", carBody());
    const link = await generateLink("coast", created.id, { gateway: PaymentGatewayKey.STRIPE });
    expect(link.status, JSON.stringify(link.json)).toBe(200);
    expect(link.order!.payment.gateway).toBe(PaymentGatewayKey.PAYPAL);
    expect(link.sessions).toHaveLength(0);
    expect(link.stripeKeys).toEqual([]);
    expect(link.paypal).toHaveLength(1);
    expect(link.paypal[0]!.purchase_units[0]!.amount).toEqual({ currency_code: "USD", value: "249.99" });
    expect(link.paypal[0]!.payment_source.paypal.experience_context.brand_name).toBe(COAST.brandName);
    expect(paypalClientIds).toEqual(["coastaltrips-client-id"]);
    expect(getCurrentTestStripe().sessionsCreated).toHaveLength(0);

    const stray = await deliverStripe(
      COAST.slug,
      checkoutCompleted(link.order!, 24999),
      TRIP_STRIPE_WEBHOOK_SECRET,
    );
    expect(stray.status, JSON.stringify(stray.body)).toBe(404);
    expect(stray.body.error).toMatchObject({ code: "NOT_FOUND", message: "Unknown endpoint" });
    expect((await storedOrder(created.id)).status).not.toBe(OrderStatus.PAID);
  }, 60_000);

  it("8d. TripReservations with Stripe enabled but its Stripe env keys REMOVED: a STRIPE link is REFUSED — 409 'Trip Reservations has no Stripe credentials configured…' — with no Stripe session and no Stripe client for ANY key (never the deployment's), nothing written; its Stripe endpoint answers the flat 404; its PayPal default still works", async () => {
    for (const k of Object.keys(TRIP_STRIPE_ENV)) delete process.env[k];
    // Still ENABLED — only the account's keys are missing.
    expect((await rawOrg("trip")).payments).toMatchObject({
      enabledProviders: [PaymentGatewayKey.PAYPAL, PaymentGatewayKey.STRIPE],
    });
    expect(await OrganizationCredential.countDocuments({ organizationId: orgIds.trip })).toBe(0);

    const created = await submitOrder("trip", flightBody());
    const before = await writtenCounts();
    const refused = await generateLink("trip", created.id, { gateway: PaymentGatewayKey.STRIPE });
    expect(refused.status, JSON.stringify(refused.json)).toBe(409);
    expect(refused.json.error).toEqual({ code: "CONFLICT", message: STRIPE_NOT_CONFIGURED });
    // No fallback: no session, no Stripe client at all — so never the
    // deployment's STRIPE_SECRET_KEY — and no PayPal either.
    expect(refused.sessions).toHaveLength(0);
    expect(refused.stripeKeys).toEqual([]);
    expect(refused.stripeKeys).not.toContain(env.server.STRIPE_SECRET_KEY);
    expect(refused.paypal).toHaveLength(0);
    expect(refused.paypalFetches).toBe(0);
    // Nothing written: the order is exactly as it was created.
    expect(await writtenCounts()).toEqual(before);
    const untouched = await storedOrder(created.id);
    expect(untouched.status).toBe(OrderStatus.NOT_INITIATED);
    expect(untouched.payment.gateway ?? null).toBeNull();
    expect(untouched.payment.stripeSessionId ?? null).toBeNull();
    expect(untouched.payment.checkoutUrl ?? null).toBeNull();

    // A Stripe delivery to its endpoint: the same flat 404 as an unknown one.
    const stray = await deliverStripe(
      TRIP.slug,
      checkoutCompleted(created, 10000),
      TRIP_STRIPE_WEBHOOK_SECRET,
    );
    expect(stray.status, JSON.stringify(stray.body)).toBe(404);
    expect(stray.body.error).toMatchObject({ code: "NOT_FOUND", message: "Unknown endpoint" });
    expect(stray.stripeKeys).toEqual([]);

    // PayPal — still its default — is unaffected.
    const onPayPal = await generateLink("trip", created.id, {});
    expect(onPayPal.status, JSON.stringify(onPayPal.json)).toBe(200);
    expect(onPayPal.order!.payment.gateway).toBe(PaymentGatewayKey.PAYPAL);
    expect(onPayPal.paypal).toHaveLength(1);
    expect(onPayPal.sessions).toHaveLength(0);
    expect(onPayPal.stripeKeys).toEqual([]);
  }, 60_000);
});
