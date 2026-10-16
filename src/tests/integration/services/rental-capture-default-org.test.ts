import { execFile } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import mongoose, { Types } from "mongoose";
import type Stripe from "stripe";

import { POST as createOrderRoute } from "@/app/api/orders/route";
import { POST as cancelAuthorizationRoute } from "@/app/api/orders/[id]/cancel-authorization/route";
import { POST as captureRoute } from "@/app/api/orders/[id]/capture/route";
import { POST as generateLinkRoute } from "@/app/api/orders/[id]/generate-payment-link/route";
import { POST as previewRoute } from "@/app/api/orders/[id]/payment-request-preview/route";
import { POST as regenerateLinkRoute } from "@/app/api/orders/[id]/regenerate-link/route";
import { POST as sendRequestRoute } from "@/app/api/orders/[id]/send-payment-request/route";
import { POST as deploymentStripeWebhookRoute } from "@/app/api/webhooks/stripe/route";
import { POST as orgStripeWebhookRoute } from "@/app/api/webhooks/stripe/[orgSlug]/route";
import {
  AuditAction,
  BookingStatus,
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
  MANUAL_CAPTURE_STRIPE_EVENTS,
  stripeWebhookPath,
} from "@/lib/organization-capture-mode";
import {
  AuditLog,
  Branding,
  Order,
  Organization,
  OrganizationCredential,
  OrganizationMember,
  PendingEmail,
} from "@/server/db/models";
import {
  DEFAULT_CANCELLATION_POLICY,
  DEFAULT_FLIGHT_TERMS_AND_CONDITIONS,
  DEFAULT_HOTEL_TERMS_AND_CONDITIONS,
  DEFAULT_TERMS_AND_CONDITIONS,
} from "@/server/db/models/setting.model";
import { orgCookieName } from "@/server/auth/org-cookie";
import { formatEmailDate } from "@/server/email/format";
import type { PaymentEventType } from "@/server/payments/gateway";
import { getDefaultGateway } from "@/server/payments/gateways";
import { _setPayPalFetchForTesting } from "@/server/payments/gateways/paypal";
import { getGatewayForOrganization } from "@/server/payments/resolve-gateway";
import { getOrganizationCaptureMode } from "@/server/services/order.service";
import { createProvider } from "@/server/services/provider.service";
import { createSettings } from "@/tests/factories/settings.factory";
import {
  buildAmountCapturableUpdated,
  buildCheckoutCompleted,
  buildCheckoutExpired,
  buildPaymentIntentCanceled,
  buildPaymentIntentFailed,
  buildPaymentIntentSucceeded,
  signWebhook,
} from "@/tests/factories/stripe-event.factory";
import { validCreateOrderInput } from "@/tests/fixtures/order-input.fixture";
import { getCurrentTestStripe } from "@/tests/setup/integration.setup";
import { buildRequest, jsonBody } from "@/tests/utils/api";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { ensureMongo } from "@/tests/utils/db";
import { setNextHeaders } from "@/tests/utils/next-headers";
import type { OrderDTO } from "@/types";

/**
 * RENTAL CONFIRMATION ON MANUAL CAPTURE — what is SPECIFIC to it being the
 * DEFAULT organization, plus the regressions that must not move.
 *
 * The manual-capture lifecycle (authorize at checkout → "Capture payment" or
 * "Release hold") is generic and data-driven: an organization opts in with
 * `payments.captureMode = MANUAL`. Rental Confirmation is not just another
 * organization, though, and this file pins every way that matters:
 *
 *   - it has NO `ORG_RENTALCONFIRMATION_*` env and no vault row, so its
 *     gateway is the DEPLOYMENT one (`env.server.STRIPE_SECRET_KEY`);
 *   - its Stripe events arrive at the DEPLOYMENT endpoint
 *     (POST /api/webhooks/stripe, `STRIPE_WEBHOOK_SECRET`), which accepts
 *     only the default organization's orders and unattributed ones;
 *   - it owns every pre-migration order — stored with `organizationId: null`
 *     or with no such key at all — which now takes ITS capture mode
 *     (`getOrganizationCaptureMode(null)`), at BOTH call sites: the first
 *     link and a regenerated one;
 *   - its emails go out under the deployment identity (EMAIL_FROM, the
 *     deployment transport, the Branding singleton's "Rental Confirmation").
 *
 * THE WORLD (production-shaped, as tripreservations-stripe.test.ts builds it):
 *
 *   rentalconfirmation   DEFAULT, Stripe only, no `serviceTypes` / `legal` /
 *                        `payments.captureMode` stored (car rental, automatic)
 *   tripreservations     PayPal default + Stripe enabled on its OWN keys
 *                        (ORG_TRIPRESERVATIONS_*), no capture mode stored —
 *                        switched to MANUAL only where a reference is needed
 *
 * Switching a mode is the one-field write that
 * `scripts/set-organization-capture-mode.ts` makes on APPLY=1 —
 * `$set: { "payments.captureMode": … }` (which Mongoose stamps with
 * `updatedAt`), made here through the raw driver — and D9 runs that script
 * itself, as a child process against this file's in-memory database. Every
 * assertion is on what the real route handlers, webhook endpoints, services
 * and script did: the Stripe stub's recorded sessions, captures and cancels,
 * the SECRET KEY each Stripe client was requested with (a spy on
 * `getStripeFor` — the stub answers any key, so the spy tells the accounts
 * apart), the stored documents (raw driver), the audit trail, the emails as
 * they left SMTP, and the script's report.
 *
 *   D1  merchant account   deployment key for Rental; own key for the reference
 *   D2  endpoint           deployment endpoint processes Rental's events; the
 *                          two endpoints refuse each other's orders; Rental's
 *                          OWN per-organization path refuses its unattributed
 *                          orders (why the default keeps the deployment one)
 *   D3  legacy orders      organizationId null / absent follows the DEFAULT
 *                          org's mode — first link AND regenerated link; the
 *                          flagged default decides, not the first stored org
 *   D4  in-flight          links made while AUTOMATIC stay automatic
 *   D5  car regression     Rental on AUTOMATIC: byte-identical session, T&C
 *                          and payment-request email unaffected by the mode
 *                          (recorded finding: so a MANUAL customer is still
 *                          told "You pay today" / "charged today")
 *   D6  TripReservations   unchanged beside a MANUAL Rental
 *   D7  emails             authorization / receipt / nothing on release
 *   D8  event list         MANUAL_CAPTURE_STRIPE_EVENTS are all handled
 *   D9  the switch         the real script for the default organization: its
 *                          report (unattributed orders, deployment endpoint)
 *                          and its one-field write
 */

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

type OrgKey = "rc" | "trip";

/** The deployment Branding singleton — Rental Confirmation's, in production. */
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

const SLUG: Record<OrgKey, string> = { rc: RC.slug, trip: TRIP.slug };

/** TripReservations' own Stripe account — TEST credentials, set the way
 *  production sets them (the deployment's env), restored after. */
const TRIP_STRIPE_SECRET_KEY = "sk_test_tripreservations_only";
const TRIP_STRIPE_WEBHOOK_SECRET = "whsec_tripreservations_only";

/** Everything TripReservations has in env: PayPal, its mailbox, its Stripe. */
const WORLD_ENV: Record<string, string> = {
  ORG_TRIPRESERVATIONS_PAYPAL_CLIENT_ID: "tripreservations-client-id",
  ORG_TRIPRESERVATIONS_PAYPAL_CLIENT_SECRET: "tripreservations-client-secret",
  ORG_TRIPRESERVATIONS_PAYPAL_WEBHOOK_ID: "WEBHOOK-TRIPRESERVATIONS",
  ORG_TRIPRESERVATIONS_PAYPAL_SANDBOX: "true",
  ORG_TRIPRESERVATIONS_SMTP_PASSWORD: "app-password",
  ORG_TRIPRESERVATIONS_STRIPE_SECRET_KEY: TRIP_STRIPE_SECRET_KEY,
  ORG_TRIPRESERVATIONS_STRIPE_WEBHOOK_SECRET: TRIP_STRIPE_WEBHOOK_SECRET,
};

/** Rental Confirmation has nothing under this prefix in production. */
const RENTAL_ENV_PREFIX = "ORG_RENTALCONFIRMATION_";

const CAR_SUPPLIER = "Budget";

/** Where each organization's Stripe events must be delivered — the rule the
 *  capture-mode script prints, mapped onto the real route handlers below. */
const DEPLOYMENT_ENDPOINT = stripeWebhookPath({ slug: RC.slug, isDefault: true });
const TRIP_ENDPOINT = stripeWebhookPath({ slug: TRIP.slug, isDefault: false });

const CHARGED_AT_CHECKOUT =
  "This order was charged at checkout. Capture and release apply only to authorized payments.";

/** The car email's money rows, as brand-leak.test.ts pins them. */
const CAR_REQUEST_ROWS =
  "What you're paying Rental cost $249.99 Deposit (due at counter) $100.00 " +
  "Amount paid online $249.99 Amount due at counter $100.00 Total rental cost $349.99";
const CAR_AUTHORIZED_ROWS =
  "What you'll be charged Rental cost $249.99 Deposit (due at counter) $100.00 " +
  "Amount authorized $249.99 Amount due at counter $100.00 Total rental cost $349.99";
const CAR_RECEIPT_ROWS =
  "Charge breakdown Rental cost $249.99 Deposit (due at counter) $100.00 " +
  "Amount paid online $249.99 Amount due at counter $100.00 Total rental cost $349.99";

const operator = actorFor(UserRole.ADMIN, { name: "Olivia Operator" });

let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;
const orgIds = {} as Record<OrgKey, Types.ObjectId>;
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
  return `10.91.${Math.floor(ipSeq / 250)}.${ipSeq % 250}`;
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

/** Rental Confirmation as production stores it: the default organization,
 *  Stripe only, no service list (reads [CAR_RENTAL]), no legal of its own,
 *  and NO capture mode (reads AUTOMATIC). */
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
  await unsetRaw(id, ["serviceTypes", "legal", "payments.captureMode"]);
  await memberOf(id);
  return id;
}

/** Trip Reservations as production has it now: PayPal the default, Stripe
 *  enabled on its own account, car + flight, no capture mode stored. */
async function makeTripReservations(): Promise<Types.ObjectId> {
  const doc = await Organization.create({
    slug: TRIP.slug,
    name: TRIP.brandName,
    brandName: TRIP.brandName,
    isDefault: false,
    payments: {
      provider: PaymentGatewayKey.PAYPAL,
      enabledProviders: [PaymentGatewayKey.PAYPAL, PaymentGatewayKey.STRIPE],
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
  await unsetRaw(id, ["legal", "payments.captureMode"]);
  await memberOf(id);
  return id;
}

/** An organization exactly as stored — raw driver, no Mongoose defaults —
 *  as plain JSON (ids and dates as strings) so it compares by value. */
async function rawOrg(key: OrgKey): Promise<Record<string, unknown>> {
  const doc = await Organization.collection.findOne({ slug: SLUG[key] });
  expect(doc, `organization ${SLUG[key]} is missing`).toBeTruthy();
  return JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
}

/**
 * Switch `key`'s capture mode with the one-field write
 * scripts/set-organization-capture-mode.ts makes on APPLY=1 —
 * `$set: { "payments.captureMode": mode }`, nothing else (the script's
 * Mongoose write also bumps `updatedAt`) — or remove the key (null): a
 * document stored before the field existed.
 */
async function setCaptureMode(key: OrgKey, mode: CaptureMode | null) {
  await Organization.collection.updateOne(
    { _id: orgIds[key] },
    mode === null
      ? { $unset: { "payments.captureMode": "" } }
      : { $set: { "payments.captureMode": mode } },
  );
  const payments = (await rawOrg(key)).payments as Record<string, unknown>;
  if (mode === null) expect(payments).not.toHaveProperty("captureMode");
  else expect(payments.captureMode).toBe(mode);
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
    const id = `PP-RENTAL-${paypalOrderSeq}`;
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
  const touched = [
    ...Object.keys(WORLD_ENV),
    ...Object.keys(process.env).filter((k) => k.startsWith(RENTAL_ENV_PREFIX)),
  ];
  envBefore = Object.fromEntries(touched.map((k) => [k, process.env[k]]));
  // Rental Confirmation's production reality: no credentials of its own.
  for (const k of Object.keys(process.env)) {
    if (k.startsWith(RENTAL_ENV_PREFIX)) delete process.env[k];
  }
  Object.assign(process.env, WORLD_ENV);
  sentMail.length = 0;
  stubPayPal();
  orgIds.rc = await makeRentalConfirmation();
  orgIds.trip = await makeTripReservations();
  // The car supplier is global, created through the catalog as seeded.
  await actingAs("rc");
  await createProvider(
    {
      key: "BUDGET",
      name: CAR_SUPPLIER,
      logo: "/providers/budget.png",
      primaryColor: "#E8590C",
      onPrimaryColor: "#FFFFFF",
      tagline: "Value-focused rentals",
      sortOrder: 0,
      serviceTypes: [ServiceType.CAR_RENTAL],
    } as Parameters<typeof createProvider>[0],
    { actor: operator },
  );
  anonymous();
});

afterEach(() => {
  sessionMock?.restore();
  sessionMock = null;
  _setPayPalFetchForTesting(null);
  for (const [k, before] of Object.entries(envBefore)) {
    if (before === undefined) delete process.env[k];
    else process.env[k] = before;
  }
  setNextHeaders({});
});

/* ------------------------------------------------------------------ *
 * Reading what was stored, sent and rendered
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
 *  name differing by brand. No `capture_method` key anywhere. */
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

/** The same car session asked to AUTHORIZE: the characterization payload
 *  with `capture_method: "manual"` added, and nothing else changed. */
function manualCarSessionExpectation(brandName: string) {
  const automatic = carSessionExpectation(brandName);
  return {
    ...automatic,
    payment_intent_data: { ...automatic.payment_intent_data, capture_method: "manual" },
  };
}

/** The secret key of every Stripe client requested while `fn` runs. The test
 *  stub answers for ANY key, so this spy on `getStripeFor` is what says which
 *  merchant account a session, capture, cancel or webhook verification used. */
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

interface StoredOrder {
  organizationId?: Types.ObjectId | null;
  serviceType: string;
  status: string;
  bookingStatus?: string | null;
  terms: { text: string; version: string };
  policy: { text: string; version: string };
  payment: {
    status: string;
    gateway?: string | null;
    stripeSessionId?: string | null;
    paymentIntentId?: string | null;
    paidAt?: Date | null;
    amountReceived?: number | null;
    capture?: {
      method: string;
      status: string;
      amountAuthorized?: number | null;
      amountCaptured?: number | null;
      cancelReason?: string | null;
    } | null;
  };
}

async function storedOrder(orderId: string): Promise<StoredOrder> {
  const doc = await Order.findById(orderId).lean<StoredOrder | null>();
  expect(doc, `order ${orderId} was not stored`).toBeTruthy();
  return doc!;
}

/** An order exactly as stored — raw driver — as plain JSON, so "nothing
 *  changed" can be asserted byte for byte. */
async function rawOrder(orderId: string): Promise<Record<string, unknown>> {
  const doc = await Order.collection.findOne({ _id: new Types.ObjectId(orderId) });
  expect(doc, `order ${orderId} is missing`).toBeTruthy();
  return JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
}

async function pendingEmails(orderId: string, kind: EmailKind): Promise<number> {
  return PendingEmail.countDocuments({ orderId: new Types.ObjectId(orderId), kind });
}

interface SentEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  from: string;
  replyTo: string | null;
  transport: string;
}

function sentSince(mark: number, kind: EmailKind): SentEmail[] {
  return sentMail
    .slice(mark)
    .filter((m) => (m.headers as Record<string, string>)["X-Entity-Kind"] === kind)
    .map((m) => ({
      to: String(m.to),
      subject: String(m.subject),
      html: String(m.html),
      text: String(m.text),
      from: String(m.from ?? ""),
      replyTo: typeof m.replyTo === "string" ? m.replyTo : null,
      transport: String(m.__transport ?? ""),
    }));
}

function onlySentSince(mark: number, kind: EmailKind): SentEmail {
  const found = sentSince(mark, kind);
  expect(found, `expected exactly one ${kind} email`).toHaveLength(1);
  return found[0]!;
}

/** Where two strings first part ways, with context — so a parity failure
 *  says WHAT differs instead of dumping two whole emails. */
function firstDifference(a: string, b: string): string {
  if (a === b) return "(identical)";
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return `at ${i}: «${a.slice(Math.max(0, i - 120), i + 120)}» vs «${b.slice(Math.max(0, i - 120), i + 120)}»`;
}

/* ------------------------------------------------------------------ *
 * What the operator, the customer and Stripe do — real routes
 * ------------------------------------------------------------------ */

const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

interface ApiError {
  ok: false;
  error: { code: string; message: string };
}

async function ok<T>(res: Response, status = 200): Promise<T> {
  const { status: got, body } = await jsonBody<{ ok: boolean; data: T }>(res);
  expect(got, JSON.stringify(body)).toBe(status);
  return body.data;
}

/** The car form, unchanged: a prepaid rental line and a deposit due at the
 *  counter. Posts no `serviceType`, exactly as the car form does. */
function carBody(overrides: Parameters<typeof validCreateOrderInput>[0] = {}) {
  return validCreateOrderInput({
    charges: [
      { name: "Rental cost", amount: 249.99, timing: PaymentTiming.PREPAID },
      { name: "Deposit", amount: 100, timing: PaymentTiming.DUE_AT_COUNTER },
    ],
    ...overrides,
  });
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

/**
 * A car order as stored BEFORE organizations existed: created through the
 * real create route (so every field is what `createOrder` writes today) and
 * then de-attributed with the raw driver — the pre-migration rows the
 * default organization owns. Production has two such shapes
 * (organization-scope.ts: "`null` / absent means the record pre-dates the
 * migration"), and `shape` picks one: an explicit `organizationId: null`, or
 * no `organizationId` key at all — a row written before the column existed.
 */
async function legacyCarOrder(shape: "null" | "absent" = "null"): Promise<OrderDTO> {
  const created = await submitOrder("rc", carBody());
  await Order.collection.updateOne(
    { _id: new Types.ObjectId(created.id) },
    shape === "null" ? { $set: { organizationId: null } } : { $unset: { organizationId: "" } },
  );
  const raw = await rawOrder(created.id);
  if (shape === "null") expect(raw.organizationId).toBeNull();
  else expect(raw).not.toHaveProperty("organizationId");
  expect(raw.serviceType).toBe(ServiceType.CAR_RENTAL);
  expect(raw.status).toBe(OrderStatus.NOT_INITIATED);
  expect((raw.payment as Record<string, unknown>).capture ?? null).toBeNull();
  return created;
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
 * composer posts. Returns the reply, every Stripe session and PayPal order
 * the click created, and the secret key of every Stripe client it asked for.
 */
async function generateLink(key: OrgKey, orderId: string, body: Record<string, unknown> = {}) {
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
  const reply = await jsonBody<
    {
      ok: boolean;
      data?: { order: OrderDTO; checkoutUrl: string; alreadyInitiated: boolean };
    } & Partial<ApiError>
  >(res);
  return {
    status: reply.status,
    json: reply.body,
    data: reply.body.data ?? null,
    order: reply.body.data?.order ?? null,
    sessions: getCurrentTestStripe().sessionsCreated.slice(stripeBefore),
    paypal: paypalCalls
      .slice(paypalBefore)
      .filter((c) => c.url.endsWith("/v2/checkout/orders"))
      .map((c) => c.body as PayPalOrderBody),
    paypalFetches: paypalFetches - fetchesBefore,
    stripeKeys: keys,
  };
}

/**
 * POST /api/orders/[id]/regenerate-link — the order page's "Regenerate link",
 * the OTHER call site that resolves a capture mode. Returns the reply, every
 * Stripe session it created and expired, and the secret key of every Stripe
 * client it asked for (its reconcile lookup, the new session, the retirement
 * of the old one).
 */
async function regenerateVia(key: OrgKey, orderId: string) {
  await actingAs(key);
  const stub = getCurrentTestStripe();
  const createdBefore = stub.sessionsCreated.length;
  const expiredBefore = stub.sessionsExpired.length;
  const { result: res, keys } = await stripeKeysDuring(() =>
    regenerateLinkRoute(
      buildRequest(`/api/orders/${orderId}/regenerate-link`, { method: "POST", body: {} }),
      idParams(orderId),
    ),
  );
  const reply = await jsonBody<
    { ok: boolean; data?: { order: OrderDTO; checkoutUrl: string } } & Partial<ApiError>
  >(res);
  return {
    status: reply.status,
    json: reply.body,
    order: reply.body.data?.order ?? null,
    sessions: stub.sessionsCreated.slice(createdBefore),
    expired: stub.sessionsExpired.slice(expiredBefore),
    stripeKeys: keys,
  };
}

/** A regeneration's idempotency-key suffix: `:regen:<uuid v4>`. */
const REGEN_UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** Create a Rental car order and generate its link (the bare composer body). */
async function linkedRentalOrder() {
  const created = await submitOrder("rc", carBody());
  const link = await generateLink("rc", created.id);
  expect(link.status, JSON.stringify(link.json)).toBe(200);
  return { created, link, order: link.order! };
}

/** POST /api/orders/[id]/capture — the "Capture payment" button. */
async function captureVia(key: OrgKey, orderId: string) {
  await actingAs(key);
  const stub = getCurrentTestStripe();
  const before = stub.capturesRequested.length;
  const { result: res, keys } = await stripeKeysDuring(() =>
    captureRoute(
      buildRequest(`/api/orders/${orderId}/capture`, {
        method: "POST",
        body: {},
        headers: { "x-forwarded-for": uniqueIp() },
      }),
      idParams(orderId),
    ),
  );
  const reply = await jsonBody<{ ok: boolean; data?: { order: OrderDTO } } & Partial<ApiError>>(res);
  return {
    status: reply.status,
    json: reply.body,
    order: reply.body.data?.order ?? null,
    stripeKeys: keys,
    captures: stub.capturesRequested.slice(before),
  };
}

/** POST /api/orders/[id]/cancel-authorization — the "Release hold" button. */
async function releaseVia(key: OrgKey, orderId: string, reason?: string) {
  await actingAs(key);
  const stub = getCurrentTestStripe();
  const before = stub.cancelsRequested.length;
  const { result: res, keys } = await stripeKeysDuring(() =>
    cancelAuthorizationRoute(
      buildRequest(`/api/orders/${orderId}/cancel-authorization`, {
        method: "POST",
        body: reason === undefined ? {} : { reason },
        headers: { "x-forwarded-for": uniqueIp() },
      }),
      idParams(orderId),
    ),
  );
  const reply = await jsonBody<{ ok: boolean; data?: { order: OrderDTO } } & Partial<ApiError>>(res);
  return {
    status: reply.status,
    json: reply.body,
    order: reply.body.data?.order ?? null,
    stripeKeys: keys,
    cancels: stub.cancelsRequested.slice(before),
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

type WebhookReply = {
  ok: boolean;
  data: Record<string, unknown>;
  error?: { code: string; message: string };
};

/**
 * A Stripe delivery to `path` — the deployment endpoint or an
 * organization's own — signed with `secret`, through the route handler that
 * serves that path. Returns the reply and the secret key of every Stripe
 * client the endpoint asked for while verifying it.
 */
async function deliver(path: string, event: Stripe.Event, secret: string) {
  anonymous();
  const payload = JSON.stringify(event);
  const request = new Request(`http://localhost${path}`, {
    method: "POST",
    headers: new Headers({
      "content-type": "application/json",
      "stripe-signature": signWebhook(payload, secret),
    }),
    body: payload,
  }) as never;
  const prefix = "/api/webhooks/stripe/";
  const orgSlug = path.startsWith(prefix) ? path.slice(prefix.length) : null;
  const { result: res, keys } = await stripeKeysDuring(() =>
    orgSlug
      ? orgStripeWebhookRoute(request, { params: Promise.resolve({ orgSlug }) })
      : deploymentStripeWebhookRoute(request),
  );
  const reply = await jsonBody<WebhookReply>(res);
  return { ...reply, stripeKeys: keys };
}

const minor = (order: OrderDTO) => Math.round(order.pricing.amount * 100);

/** A completed Stripe Checkout for `order`, as Stripe sends it: "unpaid" is
 *  a manual-capture AUTHORIZATION, "paid" a charge at checkout. */
function checkoutCompletedFor(order: OrderDTO, paymentStatus: "paid" | "unpaid") {
  return buildCheckoutCompleted({
    orderId: order.id,
    orderNumber: order.orderNumber,
    sessionId: order.payment.paymentSessionId!,
    paymentIntentId: order.payment.paymentIntentId!,
    amountTotal: minor(order),
    customerEmail: order.customer.email,
    paymentStatus,
  });
}

function capturableFor(order: OrderDTO) {
  return buildAmountCapturableUpdated({
    paymentIntentId: order.payment.paymentIntentId!,
    orderId: order.id,
    orderNumber: order.orderNumber,
    amountCapturable: minor(order),
  });
}

function succeededFor(order: OrderDTO, captureMethod: "manual" | "automatic" = "manual") {
  return buildPaymentIntentSucceeded({
    paymentIntentId: order.payment.paymentIntentId!,
    orderId: order.id,
    orderNumber: order.orderNumber,
    amountReceived: minor(order),
    captureMethod,
  });
}

function canceledFor(order: OrderDTO, cancellationReason: "automatic" | "abandoned" | "requested_by_customer") {
  return buildPaymentIntentCanceled({
    paymentIntentId: order.payment.paymentIntentId!,
    orderId: order.id,
    orderNumber: order.orderNumber,
    cancellationReason,
  });
}

/* ------------------------------------------------------------------ *
 * The operator's switch: scripts/set-organization-capture-mode.ts
 * ------------------------------------------------------------------ */

const CAPTURE_MODE_SCRIPT = "scripts/set-organization-capture-mode.ts";

interface ScriptRun {
  exitCode: number;
  stdout: string;
  stderr: string;
  ms: number;
}

/**
 * Run the capture-mode script exactly as an operator does (`npx tsx`), with
 * this test process's environment — except that MONGODB_URI / MONGODB_DB name
 * THIS file's database on the in-memory server (asserted before anything
 * runs), the runner's own plumbing (VITEST_*, NODE_OPTIONS) is left out, and
 * the knobs are exactly `knobs`. No --env-file: nothing outside this
 * environment is read. `--no-install` makes npx use the local tsx and never
 * the network. (The pattern of tripreservations-flight-enable.test.ts.)
 */
async function runSetCaptureMode(knobs: {
  ORG_SLUG: string;
  CAPTURE_MODE: string;
  APPLY?: "1";
}): Promise<ScriptRun> {
  const uri = process.env.PAYOPS_IT_MONGO_URI ?? "";
  const dbName = mongoose.connection.db?.databaseName ?? "";
  // The guard: only ever this file's database on the in-memory mongod.
  expect(uri, "MONGODB_URI must be the in-memory server").toMatch(
    /^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\/?$/,
  );
  expect(dbName, "MONGODB_DB must be this file's own database").toMatch(/^it-[0-9a-f]{8}$/);
  expect(dbName).toBe(process.env.MONGODB_DB);

  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(childEnv)) {
    if (k.startsWith("VITEST") || k === "NODE_OPTIONS") delete childEnv[k];
  }
  for (const k of ["APPLY", "ALLOW_AUTOMATIC", "CAPTURE_MODE", "ORG_SLUG"]) delete childEnv[k];
  Object.assign(childEnv, { MONGODB_URI: uri, MONGODB_DB: dbName, ...knobs });

  const started = Date.now();
  return new Promise((resolve) => {
    execFile(
      "npx",
      ["--no-install", "tsx", CAPTURE_MODE_SCRIPT],
      { cwd: process.cwd(), env: childEnv, timeout: 25_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
          ms: Date.now() - started,
        });
      },
    );
  });
}

/** A document without the keys a write is allowed to touch. */
function withoutKeys(doc: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(doc).filter(([k]) => !keys.includes(k)));
}

/** The cross-organization refusals on the audit trail, oldest first. */
async function crossOrgRefusals() {
  const rows = await AuditLog.find({
    action: AuditAction.WEBHOOK_FAILED,
    "metadata.reason": "cross_organization_event",
  })
    .sort({ _id: 1 })
    .lean<{ entityId?: string | null; metadata?: Record<string, unknown> | null }[]>();
  return rows.map((r) => ({
    eventId: r.entityId ?? null,
    type: r.metadata?.type ?? null,
    orderId: r.metadata?.orderId ? String(r.metadata.orderId) : null,
    orderOrganizationId: r.metadata?.orderOrganizationId
      ? String(r.metadata.orderOrganizationId)
      : null,
    endpointOrganizationId: r.metadata?.endpointOrganizationId
      ? String(r.metadata.endpointOrganizationId)
      : null,
  }));
}

/* ================================================================== *
 * D1. MERCHANT ACCOUNT
 * ================================================================== */

describe("D1. MERCHANT ACCOUNT — Rental's manual lifecycle runs on the DEPLOYMENT Stripe key; a non-default brand's on its own", () => {
  it("D1. Rental on MANUAL: its gateway IS the deployment registry gateway (no ORG_RENTALCONFIRMATION_* env, no vault row, with or without a STRIPE override); its link, authorization, capture and release each ask for a Stripe client on env STRIPE_SECRET_KEY and nothing else — capture(pi, {}, order:<id>:capture), cancel(pi, {cancellation_reason: abandoned}, order:<id>:cancel); TripReservations on MANUAL runs the same four steps on ITS key and never the deployment's", async () => {
    const deploymentKey = env.server.STRIPE_SECRET_KEY;
    expect(deploymentKey, "the deployment has a Stripe key").toBeTruthy();
    expect(TRIP_STRIPE_SECRET_KEY).not.toBe(deploymentKey);
    await setCaptureMode("rc", CaptureMode.MANUAL);
    await setCaptureMode("trip", CaptureMode.MANUAL);

    // Rental's merchant account, by construction: nothing of its own anywhere,
    // so the resolver hands back the registry's env-backed default gateway.
    expect(Object.keys(process.env).filter((k) => k.startsWith(RENTAL_ENV_PREFIX))).toEqual([]);
    expect(await OrganizationCredential.countDocuments({ organizationId: orgIds.rc })).toBe(0);
    expect(await getGatewayForOrganization(String(orgIds.rc))).toBe(getDefaultGateway());
    expect(
      await getGatewayForOrganization(String(orgIds.rc), PaymentGatewayKey.STRIPE),
    ).toBe(getDefaultGateway());
    // …which is also what an unattributed (pre-migration) order resolves to.
    expect(await getGatewayForOrganization(null)).toBe(getDefaultGateway());
    const tripStripe = await getGatewayForOrganization(String(orgIds.trip), PaymentGatewayKey.STRIPE);
    expect(tripStripe.key).toBe(PaymentGatewayKey.STRIPE);
    expect(tripStripe).not.toBe(getDefaultGateway());

    // ---- Rental, capture path ----
    const rcCapture = await linkedRentalOrder();
    expect(rcCapture.link.stripeKeys).toEqual([deploymentKey]);
    expect(rcCapture.link.sessions).toHaveLength(1);
    expect(rcCapture.link.sessions[0]!.manualCapture).toBe(true);
    expect(rcCapture.link.sessions[0]!.params.payment_intent_data?.capture_method).toBe("manual");
    expect(rcCapture.link.sessions[0]!.options).toEqual({
      idempotencyKey: `order:${rcCapture.created.id}:checkout:manual`,
    });
    const rcAuth = await deliver(
      DEPLOYMENT_ENDPOINT,
      checkoutCompletedFor(rcCapture.order, "unpaid"),
      env.server.STRIPE_WEBHOOK_SECRET,
    );
    expect(rcAuth.status, JSON.stringify(rcAuth.body)).toBe(200);
    expect(rcAuth.body.data).toMatchObject({ received: true, handled: true, duplicate: false });
    expect(rcAuth.stripeKeys).toEqual([deploymentKey]);
    const rcCaptured = await captureVia("rc", rcCapture.created.id);
    expect(rcCaptured.status, JSON.stringify(rcCaptured.json)).toBe(200);
    expect(rcCaptured.stripeKeys).toEqual([deploymentKey]);
    expect(rcCaptured.captures).toEqual([
      {
        id: rcCapture.order.payment.paymentIntentId,
        params: {},
        options: { idempotencyKey: `order:${rcCapture.created.id}:capture:${rcCapture.order.payment.paymentIntentId}` },
      },
    ]);
    expect(rcCaptured.order!.status).toBe(OrderStatus.PAID);
    expect(rcCaptured.order!.payment.capture?.status).toBe(PaymentCaptureStatus.CAPTURED);

    // ---- Rental, release path ----
    const rcRelease = await linkedRentalOrder();
    expect(rcRelease.link.stripeKeys).toEqual([deploymentKey]);
    expect(rcRelease.link.sessions[0]!.manualCapture).toBe(true);
    const rcAuth2 = await deliver(
      DEPLOYMENT_ENDPOINT,
      capturableFor(rcRelease.order),
      env.server.STRIPE_WEBHOOK_SECRET,
    );
    expect(rcAuth2.body.data).toMatchObject({ handled: true, duplicate: false });
    expect(rcAuth2.stripeKeys).toEqual([deploymentKey]);
    const rcReleased = await releaseVia("rc", rcRelease.created.id, "Supplier has no cars");
    expect(rcReleased.status, JSON.stringify(rcReleased.json)).toBe(200);
    expect(rcReleased.stripeKeys).toEqual([deploymentKey]);
    expect(rcReleased.cancels).toEqual([
      {
        id: rcRelease.order.payment.paymentIntentId,
        params: { cancellation_reason: "abandoned" },
        options: { idempotencyKey: `order:${rcRelease.created.id}:cancel:${rcRelease.order.payment.paymentIntentId}` },
      },
    ]);
    expect(rcReleased.order!.payment.capture?.status).toBe(PaymentCaptureStatus.CANCELLED);
    expect(rcReleased.order!.status).toBe(OrderStatus.LINK_GENERATED);

    // ---- The reference: TripReservations on MANUAL, on Stripe ----
    const tripCapture = await submitOrder("trip", carBody());
    const tripLink = await generateLink("trip", tripCapture.id, { gateway: PaymentGatewayKey.STRIPE });
    expect(tripLink.status, JSON.stringify(tripLink.json)).toBe(200);
    expect(tripLink.stripeKeys).toEqual([TRIP_STRIPE_SECRET_KEY]);
    expect(tripLink.sessions[0]!.manualCapture).toBe(true);
    expect(tripLink.sessions[0]!.options).toEqual({
      idempotencyKey: `order:${tripCapture.id}:checkout:manual`,
    });
    const tripAuth = await deliver(
      TRIP_ENDPOINT,
      checkoutCompletedFor(tripLink.order!, "unpaid"),
      TRIP_STRIPE_WEBHOOK_SECRET,
    );
    expect(tripAuth.body.data).toMatchObject({ handled: true, duplicate: false });
    expect(tripAuth.stripeKeys).toEqual([TRIP_STRIPE_SECRET_KEY]);
    const tripCaptured = await captureVia("trip", tripCapture.id);
    expect(tripCaptured.status, JSON.stringify(tripCaptured.json)).toBe(200);
    expect(tripCaptured.stripeKeys).toEqual([TRIP_STRIPE_SECRET_KEY]);
    expect(tripCaptured.captures).toEqual([
      {
        id: tripLink.order!.payment.paymentIntentId,
        params: {},
        options: { idempotencyKey: `order:${tripCapture.id}:capture:${tripLink.order!.payment.paymentIntentId}` },
      },
    ]);
    expect(tripCaptured.order!.status).toBe(OrderStatus.PAID);
    expect(tripCaptured.order!.payment.capture?.status).toBe(PaymentCaptureStatus.CAPTURED);

    const tripRelease = await submitOrder("trip", carBody());
    const tripLink2 = await generateLink("trip", tripRelease.id, { gateway: PaymentGatewayKey.STRIPE });
    expect(tripLink2.stripeKeys).toEqual([TRIP_STRIPE_SECRET_KEY]);
    expect(tripLink2.sessions[0]!.manualCapture).toBe(true);
    const tripAuth2 = await deliver(TRIP_ENDPOINT, capturableFor(tripLink2.order!), TRIP_STRIPE_WEBHOOK_SECRET);
    expect(tripAuth2.body.data).toMatchObject({ handled: true, duplicate: false });
    expect(tripAuth2.stripeKeys).toEqual([TRIP_STRIPE_SECRET_KEY]);
    expect((await storedOrder(tripRelease.id)).payment.capture?.status).toBe(PaymentCaptureStatus.AUTHORIZED);
    const tripReleased = await releaseVia("trip", tripRelease.id);
    expect(tripReleased.status, JSON.stringify(tripReleased.json)).toBe(200);
    expect(tripReleased.stripeKeys).toEqual([TRIP_STRIPE_SECRET_KEY]);
    expect(tripReleased.cancels).toEqual([
      {
        id: tripLink2.order!.payment.paymentIntentId,
        params: { cancellation_reason: "abandoned" },
        options: { idempotencyKey: `order:${tripRelease.id}:cancel:${tripLink2.order!.payment.paymentIntentId}` },
      },
    ]);
    expect(tripReleased.order!.payment.capture?.status).toBe(PaymentCaptureStatus.CANCELLED);

    // The deployment key never served the reference, nor its key Rental.
    for (const keys of [
      tripLink.stripeKeys,
      tripAuth.stripeKeys,
      tripCaptured.stripeKeys,
      tripLink2.stripeKeys,
      tripAuth2.stripeKeys,
      tripReleased.stripeKeys,
    ]) {
      expect(keys).not.toContain(deploymentKey);
    }
    for (const keys of [
      rcCapture.link.stripeKeys,
      rcAuth.stripeKeys,
      rcCaptured.stripeKeys,
      rcRelease.link.stripeKeys,
      rcAuth2.stripeKeys,
      rcReleased.stripeKeys,
    ]) {
      expect(keys).not.toContain(TRIP_STRIPE_SECRET_KEY);
    }
  }, 60_000);
});

/* ================================================================== *
 * D2. ENDPOINT
 * ================================================================== */

describe("D2. ENDPOINT — Rental's events belong to the DEPLOYMENT endpoint, and the two endpoints refuse each other's orders", () => {
  it("D2a. at POST /api/webhooks/stripe (stripeWebhookPath of the default organization) Rental's events are processed: an unpaid checkout.session.completed AUTHORIZES (status unchanged, bookingStatus PENDING, PAYMENT_AUTHORIZED queued) and payment_intent.succeeded settles it (PAID, CAPTURED $249.99, CONFIRMED, one receipt queued); payment_intent.amount_capturable_updated authorizes a second order and payment_intent.canceled 'automatic' expires it (AUTHORIZATION_EXPIRED, CANCELLED booking, status unchanged, nothing queued)", async () => {
    expect(DEPLOYMENT_ENDPOINT).toBe("/api/webhooks/stripe");
    expect(TRIP_ENDPOINT).toBe("/api/webhooks/stripe/tripreservations");
    await setCaptureMode("rc", CaptureMode.MANUAL);
    const secret = env.server.STRIPE_WEBHOOK_SECRET;
    const deploymentKey = env.server.STRIPE_SECRET_KEY;

    // 1. checkout.session.completed (unpaid) → AUTHORIZED.
    const first = await linkedRentalOrder();
    expect(first.order.payment.capture).toMatchObject({
      method: CaptureMode.MANUAL,
      status: PaymentCaptureStatus.PENDING_AUTHORIZATION,
    });
    expect(first.order.bookingStatus).toBe(BookingStatus.PENDING);
    const authorized = await deliver(DEPLOYMENT_ENDPOINT, checkoutCompletedFor(first.order, "unpaid"), secret);
    expect(authorized.status, JSON.stringify(authorized.body)).toBe(200);
    expect(authorized.body.data).toEqual({
      received: true,
      handled: true,
      duplicate: false,
      orderId: first.created.id,
    });
    // Verified on the deployment account, and nothing else.
    expect(authorized.stripeKeys).toEqual([deploymentKey]);
    const held = await storedOrder(first.created.id);
    expect(held.status).toBe(OrderStatus.LINK_GENERATED);
    expect(held.payment.status).toBe(OrderStatus.LINK_GENERATED);
    expect(held.payment.paidAt ?? null).toBeNull();
    expect(held.payment.capture).toMatchObject({
      method: CaptureMode.MANUAL,
      status: PaymentCaptureStatus.AUTHORIZED,
      amountAuthorized: 249.99,
    });
    expect(held.bookingStatus).toBe(BookingStatus.PENDING);
    expect(await pendingEmails(first.created.id, EmailKind.PAYMENT_AUTHORIZED)).toBe(1);
    expect(await pendingEmails(first.created.id, EmailKind.PAYMENT_CONFIRMATION)).toBe(0);

    // 2. payment_intent.succeeded (a capture made in Stripe) → PAID + CAPTURED.
    const captured = await deliver(DEPLOYMENT_ENDPOINT, succeededFor(first.order), secret);
    expect(captured.status, JSON.stringify(captured.body)).toBe(200);
    expect(captured.body.data).toMatchObject({ handled: true, duplicate: false, orderId: first.created.id });
    expect(captured.stripeKeys).toEqual([deploymentKey]);
    const paid = await storedOrder(first.created.id);
    expect(paid.status).toBe(OrderStatus.PAID);
    expect(paid.payment.amountReceived).toBe(249.99);
    expect(paid.payment.capture).toMatchObject({
      status: PaymentCaptureStatus.CAPTURED,
      amountCaptured: 249.99,
    });
    expect(paid.bookingStatus).toBe(BookingStatus.CONFIRMED);
    expect(await pendingEmails(first.created.id, EmailKind.PAYMENT_CONFIRMATION)).toBe(1);

    // 3. payment_intent.amount_capturable_updated → AUTHORIZED.
    const second = await linkedRentalOrder();
    const capturable = await deliver(DEPLOYMENT_ENDPOINT, capturableFor(second.order), secret);
    expect(capturable.body.data).toEqual({
      received: true,
      handled: true,
      duplicate: false,
      orderId: second.created.id,
    });
    expect(capturable.stripeKeys).toEqual([deploymentKey]);
    expect((await storedOrder(second.created.id)).payment.capture?.status).toBe(
      PaymentCaptureStatus.AUTHORIZED,
    );

    // 4. payment_intent.canceled "automatic" (Stripe let the hold lapse) → expired.
    const queuedBefore = await PendingEmail.countDocuments({});
    const lapsed = await deliver(DEPLOYMENT_ENDPOINT, canceledFor(second.order, "automatic"), secret);
    expect(lapsed.body.data).toEqual({
      received: true,
      handled: true,
      duplicate: false,
      orderId: second.created.id,
    });
    expect(lapsed.stripeKeys).toEqual([deploymentKey]);
    const expired = await storedOrder(second.created.id);
    expect(expired.payment.capture).toMatchObject({
      status: PaymentCaptureStatus.AUTHORIZATION_EXPIRED,
      cancelReason: "automatic",
    });
    expect(expired.bookingStatus).toBe(BookingStatus.CANCELLED);
    expect(expired.status).toBe(OrderStatus.LINK_GENERATED);
    expect(await PendingEmail.countDocuments({})).toBe(queuedBefore);

    // Not one of Rental's own events was refused.
    expect(await crossOrgRefusals()).toEqual([]);
  }, 60_000);

  it("D2b. Rental's events delivered to TripReservations' endpoint (signed with its secret) → 200 order_not_found, one WEBHOOK_FAILED cross_organization_event each, the order byte-identical, nothing queued; TripReservations' event at the deployment endpoint → refused the same way; a Rental event signed with TripReservations' secret at the deployment endpoint → 400 'Invalid signature', nothing changed — and the very event refused first (same id), delivered to the deployment endpoint, is processed: a refusal consumes nothing", async () => {
    await setCaptureMode("rc", CaptureMode.MANUAL);
    await setCaptureMode("trip", CaptureMode.MANUAL);
    const rental = (await linkedRentalOrder()).order;
    const tripCreated = await submitOrder("trip", carBody());
    const tripLink = await generateLink("trip", tripCreated.id, { gateway: PaymentGatewayKey.STRIPE });
    expect(tripLink.status, JSON.stringify(tripLink.json)).toBe(200);
    const trip = tripLink.order!;
    expect(trip.payment.capture?.status).toBe(PaymentCaptureStatus.PENDING_AUTHORIZATION);
    const rentalBefore = await rawOrder(rental.id);
    const tripBefore = await rawOrder(trip.id);

    // 1. Rental's events at TripReservations' endpoint: verified on
    //    TripReservations' account, then refused at the tenancy chokepoint.
    const rentalEvents = [
      checkoutCompletedFor(rental, "unpaid"),
      capturableFor(rental),
      succeededFor(rental),
      canceledFor(rental, "automatic"),
    ];
    for (const event of rentalEvents) {
      const refused = await deliver(TRIP_ENDPOINT, event, TRIP_STRIPE_WEBHOOK_SECRET);
      expect(refused.status, `${event.type}: ${JSON.stringify(refused.body)}`).toBe(200);
      expect(refused.body.data, event.type).toEqual({
        received: true,
        handled: false,
        duplicate: false,
        reason: "order_not_found",
      });
      expect(refused.stripeKeys, event.type).toEqual([TRIP_STRIPE_SECRET_KEY]);
    }
    expect(await rawOrder(rental.id)).toEqual(rentalBefore);
    expect(await PendingEmail.countDocuments({ orderId: new Types.ObjectId(rental.id) })).toBe(0);
    expect(await crossOrgRefusals()).toEqual(
      rentalEvents.map((event, i) => ({
        eventId: event.id,
        type: ["payment.authorized", "payment.authorized", "payment.captured", "payment.cancelled"][i],
        orderId: rental.id,
        orderOrganizationId: String(orgIds.rc),
        endpointOrganizationId: String(orgIds.trip),
      })),
    );

    // 2. TripReservations' event at the DEPLOYMENT endpoint (signed with the
    //    deployment secret, so it verifies) → refused the same way.
    const tripEvent = checkoutCompletedFor(trip, "unpaid");
    const atDeployment = await deliver(DEPLOYMENT_ENDPOINT, tripEvent, env.server.STRIPE_WEBHOOK_SECRET);
    expect(atDeployment.status, JSON.stringify(atDeployment.body)).toBe(200);
    expect(atDeployment.body.data).toEqual({
      received: true,
      handled: false,
      duplicate: false,
      reason: "order_not_found",
    });
    expect(await rawOrder(trip.id)).toEqual(tripBefore);
    expect((await crossOrgRefusals()).at(-1)).toEqual({
      eventId: tripEvent.id,
      type: "payment.authorized",
      orderId: trip.id,
      orderOrganizationId: String(orgIds.trip),
      endpointOrganizationId: null,
    });

    // 3. A Rental event signed with TripReservations' secret at the
    //    deployment endpoint: the signature fails, nothing is processed.
    const failedBefore = await AuditLog.countDocuments({
      action: AuditAction.WEBHOOK_FAILED,
      "metadata.reason": "invalid_signature",
    });
    const forged = await deliver(
      DEPLOYMENT_ENDPOINT,
      checkoutCompletedFor(rental, "unpaid"),
      TRIP_STRIPE_WEBHOOK_SECRET,
    );
    expect(forged.status, JSON.stringify(forged.body)).toBe(400);
    expect(forged.body.error).toEqual({ code: "BAD_REQUEST", message: "Invalid signature" });
    expect(await rawOrder(rental.id)).toEqual(rentalBefore);
    expect(
      await AuditLog.countDocuments({
        action: AuditAction.WEBHOOK_FAILED,
        "metadata.reason": "invalid_signature",
        "metadata.organizationSlug": null,
      }),
    ).toBe(failedBefore + 1);
    expect(await crossOrgRefusals()).toHaveLength(5);

    // 4. The positive control: the SAME event TripReservations' endpoint
    //    refused in step 1 (same id), signed with the deployment secret, is
    //    Rental's — so a refusal consumed nothing (no dedupe claim burned).
    const genuine = await deliver(DEPLOYMENT_ENDPOINT, rentalEvents[0]!, env.server.STRIPE_WEBHOOK_SECRET);
    expect(genuine.status, JSON.stringify(genuine.body)).toBe(200);
    expect(genuine.body.data).toEqual({
      received: true,
      handled: true,
      duplicate: false,
      orderId: rental.id,
    });
    expect((await storedOrder(rental.id)).payment.capture?.status).toBe(PaymentCaptureStatus.AUTHORIZED);
    expect(await pendingEmails(rental.id, EmailKind.PAYMENT_AUTHORIZED)).toBe(1);
    expect(await crossOrgRefusals()).toHaveLength(5);
  }, 60_000);

  it("D2c. why the DEFAULT organization keeps the deployment endpoint: an unattributed (pre-migration) Rental order's event at Rental's OWN per-organization path /api/webhooks/stripe/rentalconfirmation is verified on the deployment account and then refused (order_not_found, cross_organization_event with orderOrganizationId null, order byte-identical, nothing queued) — while the SAME event at POST /api/webhooks/stripe, which stripeWebhookPath names for the default organization, authorizes it", async () => {
    await setCaptureMode("rc", CaptureMode.MANUAL);
    const secret = env.server.STRIPE_WEBHOOK_SECRET;
    const deploymentKey = env.server.STRIPE_SECRET_KEY;
    // The path the default organization would be told if it were treated
    // like every other one — and the path it is actually told.
    const rentalOwnPath = stripeWebhookPath({ slug: RC.slug, isDefault: false });
    expect(rentalOwnPath).toBe(`/api/webhooks/stripe/${RC.slug}`);
    expect(stripeWebhookPath({ slug: RC.slug, isDefault: true })).toBe(DEPLOYMENT_ENDPOINT);

    const legacy = await legacyCarOrder();
    const link = await generateLink("rc", legacy.id);
    expect(link.status, JSON.stringify(link.json)).toBe(200);
    const order = link.order!;
    expect(order.payment.capture?.status).toBe(PaymentCaptureStatus.PENDING_AUTHORIZATION);
    const before = await rawOrder(legacy.id);
    const event = checkoutCompletedFor(order, "unpaid");

    const refused = await deliver(rentalOwnPath, event, secret);
    expect(refused.status, JSON.stringify(refused.body)).toBe(200);
    expect(refused.body.data).toEqual({
      received: true,
      handled: false,
      duplicate: false,
      reason: "order_not_found",
    });
    // Verified on Rental's own gateway — the deployment account — so this is
    // the tenancy rule refusing it, not a bad signature or an unknown path.
    expect(refused.stripeKeys).toEqual([deploymentKey]);
    expect(await rawOrder(legacy.id)).toEqual(before);
    expect(await PendingEmail.countDocuments({ orderId: new Types.ObjectId(legacy.id) })).toBe(0);
    expect(await crossOrgRefusals()).toEqual([
      {
        eventId: event.id,
        type: "payment.authorized",
        orderId: legacy.id,
        orderOrganizationId: null,
        endpointOrganizationId: String(orgIds.rc),
      },
    ]);

    // The very same event at the deployment endpoint: Rental's.
    const accepted = await deliver(DEPLOYMENT_ENDPOINT, event, secret);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body.data).toEqual({
      received: true,
      handled: true,
      duplicate: false,
      orderId: legacy.id,
    });
    expect(accepted.stripeKeys).toEqual([deploymentKey]);
    expect((await storedOrder(legacy.id)).payment.capture?.status).toBe(PaymentCaptureStatus.AUTHORIZED);
    expect(await pendingEmails(legacy.id, EmailKind.PAYMENT_AUTHORIZED)).toBe(1);
    expect(await crossOrgRefusals()).toHaveLength(1);
  }, 60_000);
});

/* ================================================================== *
 * D3. LEGACY NULL-ORGANIZATION ORDERS
 * ================================================================== */

describe("D3. LEGACY ORDERS — an order stored with organizationId null follows the DEFAULT organization's capture mode", () => {
  it("D3a. a pre-migration car order (organizationId null) with Rental on MANUAL and selected: the link is a manual session on the deployment key (the car payload + capture_method 'manual', order:<id>:checkout:manual) and payment.capture {MANUAL, PENDING_AUTHORIZATION}; TripReservations can neither reach it nor take its events; the deployment endpoint authorizes it (authorization email under the deployment identity) and the capture route settles it — PAID, CAPTURED, CONFIRMED, one receipt — with organizationId still null", async () => {
    await setCaptureMode("rc", CaptureMode.MANUAL);
    const legacy = await legacyCarOrder();
    expect(await getOrganizationCaptureMode(null)).toBe(CaptureMode.MANUAL);

    const link = await generateLink("rc", legacy.id);
    expect(link.status, JSON.stringify(link.json)).toBe(200);
    expect(link.stripeKeys).toEqual([env.server.STRIPE_SECRET_KEY]);
    expect(link.sessions).toHaveLength(1);
    const { params, options, manualCapture } = link.sessions[0]!;
    expect(manualCapture).toBe(true);
    expect(params.payment_intent_data?.capture_method).toBe("manual");
    expect(normalise(params, idsOf(legacy))).toEqual(manualCarSessionExpectation(RC.brandName));
    expect(options).toEqual({ idempotencyKey: `order:${legacy.id}:checkout:manual` });
    const linked = link.order!;
    expect(linked.status).toBe(OrderStatus.LINK_GENERATED);
    expect(linked.payment.capture).toMatchObject({
      method: CaptureMode.MANUAL,
      status: PaymentCaptureStatus.PENDING_AUTHORIZATION,
    });
    expect(linked.bookingStatus).toBe(BookingStatus.PENDING);
    expect((await rawOrder(legacy.id)).organizationId).toBeNull();

    // Not TripReservations' order: its capture route and its endpoint refuse.
    const foreign = await captureVia("trip", legacy.id);
    expect(foreign.status, JSON.stringify(foreign.json)).toBe(404);
    expect(foreign.json.error).toEqual({ code: "NOT_FOUND", message: "Order not found" });
    expect(foreign.captures).toEqual([]);
    expect(foreign.stripeKeys).toEqual([]);
    const misdelivered = await deliver(
      TRIP_ENDPOINT,
      checkoutCompletedFor(linked, "unpaid"),
      TRIP_STRIPE_WEBHOOK_SECRET,
    );
    expect(misdelivered.body.data).toMatchObject({ handled: false, reason: "order_not_found" });
    expect(await crossOrgRefusals()).toEqual([
      expect.objectContaining({
        orderId: legacy.id,
        orderOrganizationId: null,
        endpointOrganizationId: String(orgIds.trip),
      }),
    ]);
    expect((await storedOrder(legacy.id)).payment.capture?.status).toBe(
      PaymentCaptureStatus.PENDING_AUTHORIZATION,
    );

    // The deployment endpoint owns it: authorized.
    const authorized = await deliver(
      DEPLOYMENT_ENDPOINT,
      checkoutCompletedFor(linked, "unpaid"),
      env.server.STRIPE_WEBHOOK_SECRET,
    );
    expect(authorized.status, JSON.stringify(authorized.body)).toBe(200);
    expect(authorized.body.data).toEqual({
      received: true,
      handled: true,
      duplicate: false,
      orderId: legacy.id,
    });
    const held = await storedOrder(legacy.id);
    expect(held.payment.capture).toMatchObject({
      status: PaymentCaptureStatus.AUTHORIZED,
      amountAuthorized: 249.99,
    });
    expect(held.status).toBe(OrderStatus.LINK_GENERATED);
    const queued = await PendingEmail.findOne({
      orderId: new Types.ObjectId(legacy.id),
      kind: EmailKind.PAYMENT_AUTHORIZED,
    }).lean<{ organizationId?: Types.ObjectId | null } | null>();
    expect(queued, "no authorization email queued").toBeTruthy();
    expect(queued!.organizationId ?? null).toBeNull();
    let mark = sentMail.length;
    expect((await drainPendingEmails(10)).sent).toBe(1);
    const heldEmail = onlySentSince(mark, EmailKind.PAYMENT_AUTHORIZED);
    expect(heldEmail.subject).toBe(`${CAR_SUPPLIER} card authorized — not yet charged • ${legacy.orderNumber}`);
    expect(heldEmail.from).toBe(env.server.EMAIL_FROM);
    expect(heldEmail.transport).toBe("deployment");

    // The operator captures it.
    const captured = await captureVia("rc", legacy.id);
    expect(captured.status, JSON.stringify(captured.json)).toBe(200);
    expect(captured.stripeKeys).toEqual([env.server.STRIPE_SECRET_KEY]);
    expect(captured.captures).toEqual([
      {
        id: linked.payment.paymentIntentId,
        params: {},
        options: { idempotencyKey: `order:${legacy.id}:capture:${linked.payment.paymentIntentId}` },
      },
    ]);
    const settled = captured.order!;
    expect(settled.status).toBe(OrderStatus.PAID);
    expect(settled.payment.amountReceived).toBe(249.99);
    expect(settled.payment.capture).toMatchObject({
      status: PaymentCaptureStatus.CAPTURED,
      amountCaptured: 249.99,
    });
    expect(settled.bookingStatus).toBe(BookingStatus.CONFIRMED);
    expect((await rawOrder(legacy.id)).organizationId).toBeNull();
    mark = sentMail.length;
    expect((await drainPendingEmails(10)).sent).toBe(1);
    const receipt = onlySentSince(mark, EmailKind.PAYMENT_CONFIRMATION);
    expect(receipt.subject).toBe(`${CAR_SUPPLIER} booking confirmed • ${legacy.orderNumber}`);
    expect(receipt.from).toBe(env.server.EMAIL_FROM);
  }, 60_000);

  it("D3b. with Rental on AUTOMATIC — nothing stored (production today) or AUTOMATIC stored — a pre-migration order's link (organizationId null, or no such key at all) is the automatic one: the characterization payload with NO capture_method key, order:<id>:checkout, payment.capture null; its capture and release routes answer 409 'charged at checkout'", async () => {
    expect((await rawOrg("rc")).payments).not.toHaveProperty("captureMode");
    expect(await getOrganizationCaptureMode(null)).toBe(CaptureMode.AUTOMATIC);
    const nothingStored = await legacyCarOrder();
    const first = await generateLink("rc", nothingStored.id);

    await setCaptureMode("rc", CaptureMode.AUTOMATIC);
    expect(await getOrganizationCaptureMode(null)).toBe(CaptureMode.AUTOMATIC);
    const automaticStored = await legacyCarOrder();
    const second = await generateLink("rc", automaticStored.id);
    // The other pre-migration shape: no organizationId key at all.
    const noKey = await legacyCarOrder("absent");
    const third = await generateLink("rc", noKey.id);

    for (const [order, link] of [
      [nothingStored, first],
      [automaticStored, second],
      [noKey, third],
    ] as const) {
      expect(link.status, JSON.stringify(link.json)).toBe(200);
      expect(link.stripeKeys).toEqual([env.server.STRIPE_SECRET_KEY]);
      expect(link.sessions).toHaveLength(1);
      const { params, options, manualCapture } = link.sessions[0]!;
      expect(manualCapture).toBe(false);
      expect(Object.keys(params.payment_intent_data ?? {})).not.toContain("capture_method");
      expect(JSON.stringify(params)).not.toContain("capture_method");
      expect(normalise(params, idsOf(order))).toEqual(carSessionExpectation(RC.brandName));
      expect(options).toEqual({ idempotencyKey: `order:${order.id}:checkout` });
      expect(link.order!.payment.capture).toBeNull();
      expect(link.order!.bookingStatus).toBeNull();
      expect((await rawOrder(order.id)).organizationId ?? null).toBeNull();
    }

    const linkedBefore = await rawOrder(nothingStored.id);
    const capture = await captureVia("rc", nothingStored.id);
    expect(capture.status, JSON.stringify(capture.json)).toBe(409);
    expect(capture.json.error).toEqual({ code: "CONFLICT", message: CHARGED_AT_CHECKOUT });
    expect(capture.captures).toEqual([]);
    const release = await releaseVia("rc", nothingStored.id);
    expect(release.status, JSON.stringify(release.json)).toBe(409);
    expect(release.json.error).toEqual({ code: "CONFLICT", message: CHARGED_AT_CHECKOUT });
    expect(release.cancels).toEqual([]);
    expect(await rawOrder(nothingStored.id)).toEqual(linkedBefore);
  }, 60_000);

  it("D3c. getOrganizationCaptureMode, directly: null or '' reads the DEFAULT organization's stored mode (nothing stored → AUTOMATIC, MANUAL → MANUAL, AUTOMATIC → AUTOMATIC); 'not-an-id' and an unknown id → AUTOMATIC; a non-default organization's id → its OWN value whatever the default's; with no organizations at all → AUTOMATIC; and it is the organization FLAGGED isDefault that decides, not the first one stored", async () => {
    // Default organization storing nothing.
    expect((await rawOrg("rc")).payments).not.toHaveProperty("captureMode");
    expect(await getOrganizationCaptureMode(null)).toBe(CaptureMode.AUTOMATIC);
    expect(await getOrganizationCaptureMode("")).toBe(CaptureMode.AUTOMATIC);
    expect(await getOrganizationCaptureMode(String(orgIds.rc))).toBe(CaptureMode.AUTOMATIC);

    // Default organization on MANUAL.
    await setCaptureMode("rc", CaptureMode.MANUAL);
    expect(await getOrganizationCaptureMode(null)).toBe(CaptureMode.MANUAL);
    expect(await getOrganizationCaptureMode("")).toBe(CaptureMode.MANUAL);
    expect(await getOrganizationCaptureMode(String(orgIds.rc))).toBe(CaptureMode.MANUAL);
    expect(await getOrganizationCaptureMode("not-an-id")).toBe(CaptureMode.AUTOMATIC);
    expect(await getOrganizationCaptureMode(String(new Types.ObjectId()))).toBe(CaptureMode.AUTOMATIC);
    // TripReservations stores nothing: AUTOMATIC, whatever the default runs.
    expect((await rawOrg("trip")).payments).not.toHaveProperty("captureMode");
    expect(await getOrganizationCaptureMode(String(orgIds.trip))).toBe(CaptureMode.AUTOMATIC);

    // Default organization on AUTOMATIC (stored), TripReservations on MANUAL.
    await setCaptureMode("rc", CaptureMode.AUTOMATIC);
    await setCaptureMode("trip", CaptureMode.MANUAL);
    expect(await getOrganizationCaptureMode(null)).toBe(CaptureMode.AUTOMATIC);
    expect(await getOrganizationCaptureMode("")).toBe(CaptureMode.AUTOMATIC);
    expect(await getOrganizationCaptureMode(String(orgIds.trip))).toBe(CaptureMode.MANUAL);

    // No organizations at all (an unmigrated deployment).
    await Organization.deleteMany({});
    expect(await Organization.countDocuments({})).toBe(0);
    expect(await getOrganizationCaptureMode(null)).toBe(CaptureMode.AUTOMATIC);
    expect(await getOrganizationCaptureMode("")).toBe(CaptureMode.AUTOMATIC);
    expect(await getOrganizationCaptureMode(String(orgIds.trip))).toBe(CaptureMode.AUTOMATIC);

    // It is the organization FLAGGED default that decides — not whichever
    // one is stored first. Above, Rental was always inserted first, so a
    // lookup that took the first organization would have passed; here a
    // non-default organization is stored BEFORE the default (natural order
    // puts it first — the precondition that makes this case bite).
    const early = await Organization.create({
      slug: "earlybrand",
      name: "Early Brand",
      brandName: "Early Brand",
      isDefault: false,
      payments: { provider: PaymentGatewayKey.STRIPE, captureMode: CaptureMode.MANUAL },
    });
    const lateDefault = await Organization.create({
      slug: RC.slug,
      name: RC.brandName,
      brandName: RC.brandName,
      isDefault: true,
      payments: { provider: PaymentGatewayKey.STRIPE },
    });
    await unsetRaw(lateDefault._id as Types.ObjectId, ["payments.captureMode"]);
    expect((await Organization.collection.findOne({}))?.slug, "natural order").toBe("earlybrand");
    // Default stores nothing, the first-stored org is MANUAL → AUTOMATIC.
    expect(await getOrganizationCaptureMode(null)).toBe(CaptureMode.AUTOMATIC);
    expect(await getOrganizationCaptureMode("")).toBe(CaptureMode.AUTOMATIC);
    expect(await getOrganizationCaptureMode(String(early._id))).toBe(CaptureMode.MANUAL);
    // …and the other way round: default MANUAL, the first-stored org nothing.
    await Organization.collection.updateOne({ _id: early._id }, { $unset: { "payments.captureMode": "" } });
    await Organization.collection.updateOne(
      { _id: lateDefault._id },
      { $set: { "payments.captureMode": CaptureMode.MANUAL } },
    );
    expect(await getOrganizationCaptureMode(null)).toBe(CaptureMode.MANUAL);
    expect(await getOrganizationCaptureMode("")).toBe(CaptureMode.MANUAL);
    expect(await getOrganizationCaptureMode(String(early._id))).toBe(CaptureMode.AUTOMATIC);
  }, 60_000);

  it("D3d. the other pre-migration shape — NO organizationId key at all, a row written before the column existed — runs the same lifecycle: Rental on MANUAL and selected, its link is the manual car session on the deployment key (order:<id>:checkout:manual) with payment.capture {MANUAL, PENDING_AUTHORIZATION}; TripReservations cannot reach it; the deployment endpoint authorizes it and the capture route settles it PAID / CAPTURED / CONFIRMED", async () => {
    await setCaptureMode("rc", CaptureMode.MANUAL);
    const deploymentKey = env.server.STRIPE_SECRET_KEY;
    const noKey = await legacyCarOrder("absent");

    const link = await generateLink("rc", noKey.id);
    expect(link.status, JSON.stringify(link.json)).toBe(200);
    expect(link.stripeKeys).toEqual([deploymentKey]);
    expect(link.sessions).toHaveLength(1);
    const { params, options, manualCapture } = link.sessions[0]!;
    expect(manualCapture).toBe(true);
    expect(normalise(params, idsOf(noKey))).toEqual(manualCarSessionExpectation(RC.brandName));
    expect(options).toEqual({ idempotencyKey: `order:${noKey.id}:checkout:manual` });
    const linked = link.order!;
    expect(linked.payment.capture).toMatchObject({
      method: CaptureMode.MANUAL,
      status: PaymentCaptureStatus.PENDING_AUTHORIZATION,
    });
    expect(linked.bookingStatus).toBe(BookingStatus.PENDING);

    // Not TripReservations' to touch.
    const foreign = await captureVia("trip", noKey.id);
    expect(foreign.status, JSON.stringify(foreign.json)).toBe(404);
    expect(foreign.captures).toEqual([]);
    expect(foreign.stripeKeys).toEqual([]);

    const authorized = await deliver(
      DEPLOYMENT_ENDPOINT,
      checkoutCompletedFor(linked, "unpaid"),
      env.server.STRIPE_WEBHOOK_SECRET,
    );
    expect(authorized.body.data).toEqual({
      received: true,
      handled: true,
      duplicate: false,
      orderId: noKey.id,
    });
    expect((await storedOrder(noKey.id)).payment.capture).toMatchObject({
      status: PaymentCaptureStatus.AUTHORIZED,
      amountAuthorized: 249.99,
    });

    const captured = await captureVia("rc", noKey.id);
    expect(captured.status, JSON.stringify(captured.json)).toBe(200);
    expect(captured.stripeKeys).toEqual([deploymentKey]);
    expect(captured.captures).toEqual([
      {
        id: linked.payment.paymentIntentId,
        params: {},
        options: { idempotencyKey: `order:${noKey.id}:capture:${linked.payment.paymentIntentId}` },
      },
    ]);
    expect(captured.order!.status).toBe(OrderStatus.PAID);
    expect(captured.order!.payment.capture).toMatchObject({
      status: PaymentCaptureStatus.CAPTURED,
      amountCaptured: 249.99,
    });
    expect(captured.order!.bookingStatus).toBe(BookingStatus.CONFIRMED);
    // Still unattributed: nothing on the way stamped it onto an organization.
    expect((await rawOrder(noKey.id)).organizationId ?? null).toBeNull();
  }, 60_000);

  it("D3e. the OTHER call site — regenerating a pre-migration order's link — follows the DEFAULT organization's mode too: on AUTOMATIC (nothing stored) a legacy link regenerates automatic (the car payload, NO capture_method, order:<id>:checkout:regen:<uuid>, capture null); on MANUAL a released legacy hold is re-issued as a manual session on the deployment key (order:<id>:checkout:manual:regen:<uuid>, the car payload + capture_method 'manual'), payment.capture re-armed {MANUAL, PENDING_AUTHORIZATION} against the new intent, the old session retired, and the new authorization lands at the deployment endpoint", async () => {
    const deploymentKey = env.server.STRIPE_SECRET_KEY;
    const secret = env.server.STRIPE_WEBHOOK_SECRET;

    // ---- AUTOMATIC (nothing stored — production today) ----
    expect((await rawOrg("rc")).payments).not.toHaveProperty("captureMode");
    const onAutomatic = await legacyCarOrder();
    const firstA = await generateLink("rc", onAutomatic.id);
    expect(firstA.status, JSON.stringify(firstA.json)).toBe(200);
    expect(firstA.sessions[0]!.manualCapture).toBe(false);
    const regenA = await regenerateVia("rc", onAutomatic.id);
    expect(regenA.status, JSON.stringify(regenA.json)).toBe(200);
    expect(regenA.sessions).toHaveLength(1);
    expect(regenA.sessions[0]!.manualCapture).toBe(false);
    expect(JSON.stringify(regenA.sessions[0]!.params)).not.toContain("capture_method");
    expect(normalise(regenA.sessions[0]!.params, idsOf(onAutomatic))).toEqual(
      carSessionExpectation(RC.brandName),
    );
    expect(regenA.sessions[0]!.options?.idempotencyKey).toMatch(
      new RegExp(`^order:${onAutomatic.id}:checkout:regen:${REGEN_UUID}$`),
    );
    // Every Stripe client it asked for — reconcile lookup, new session,
    // retiring the old one — is the deployment account's.
    expect(new Set(regenA.stripeKeys)).toEqual(new Set([deploymentKey]));
    expect(regenA.expired).toEqual([firstA.order!.payment.paymentSessionId]);
    expect(regenA.order!.payment.capture).toBeNull();
    expect(regenA.order!.bookingStatus).toBeNull();
    expect((await rawOrder(onAutomatic.id)).organizationId).toBeNull();

    // ---- MANUAL ----
    await setCaptureMode("rc", CaptureMode.MANUAL);
    const legacy = await legacyCarOrder();
    const first = await generateLink("rc", legacy.id);
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    expect(first.sessions[0]!.manualCapture).toBe(true);
    const held = await deliver(DEPLOYMENT_ENDPOINT, checkoutCompletedFor(first.order!, "unpaid"), secret);
    expect(held.body.data).toMatchObject({ handled: true, duplicate: false, orderId: legacy.id });
    const released = await releaseVia("rc", legacy.id, "Supplier could not confirm");
    expect(released.status, JSON.stringify(released.json)).toBe(200);
    expect(released.order!.payment.capture?.status).toBe(PaymentCaptureStatus.CANCELLED);

    const regen = await regenerateVia("rc", legacy.id);
    expect(regen.status, JSON.stringify(regen.json)).toBe(200);
    expect(regen.sessions).toHaveLength(1);
    const { params, options, manualCapture, result } = regen.sessions[0]!;
    expect(manualCapture).toBe(true);
    expect(params.payment_intent_data?.capture_method).toBe("manual");
    expect(normalise(params, idsOf(legacy))).toEqual(manualCarSessionExpectation(RC.brandName));
    expect(options?.idempotencyKey).toMatch(
      new RegExp(`^order:${legacy.id}:checkout:manual:regen:${REGEN_UUID}$`),
    );
    expect(new Set(regen.stripeKeys)).toEqual(new Set([deploymentKey]));
    expect(regen.expired).toEqual([first.order!.payment.paymentSessionId]);
    const rearmed = regen.order!;
    expect(rearmed.status).toBe(OrderStatus.PAYMENT_PENDING);
    expect(rearmed.payment.paymentSessionId).toBe(result.id);
    expect(rearmed.payment.paymentIntentId).toBe(result.payment_intent);
    expect(rearmed.payment.paymentIntentId).not.toBe(first.order!.payment.paymentIntentId);
    expect(rearmed.payment.capture).toMatchObject({
      method: CaptureMode.MANUAL,
      status: PaymentCaptureStatus.PENDING_AUTHORIZATION,
      amountAuthorized: null,
      cancelReason: null,
    });
    expect(rearmed.bookingStatus).toBe(BookingStatus.PENDING);
    expect((await rawOrder(legacy.id)).organizationId).toBeNull();

    // The customer authorizes the NEW session; the deployment endpoint takes it.
    const reauthorized = await deliver(DEPLOYMENT_ENDPOINT, checkoutCompletedFor(rearmed, "unpaid"), secret);
    expect(reauthorized.body.data).toEqual({
      received: true,
      handled: true,
      duplicate: false,
      orderId: legacy.id,
    });
    expect((await storedOrder(legacy.id)).payment.capture).toMatchObject({
      status: PaymentCaptureStatus.AUTHORIZED,
      amountAuthorized: 249.99,
    });
  }, 60_000);
});

/* ================================================================== *
 * D4. HISTORICAL / IN-FLIGHT ORDERS
 * ================================================================== */

describe("D4. IN-FLIGHT — a link generated while Rental was AUTOMATIC stays automatic after the switch to MANUAL", () => {
  it("D4. the switch touches no order: an open automatic link clicked again returns the SAME session (alreadyInitiated, no Stripe call, no capture_method) while a NEW order is manual; a 'paid' checkout.session.completed settles the open one PAID with capture null and a receipt queued; capture and release answer 409 'charged at checkout' for it and for an order PAID before the switch, which stays byte-identical", async () => {
    const secret = env.server.STRIPE_WEBHOOK_SECRET;
    // While Rental is AUTOMATIC (nothing stored): one open link, one paid order.
    const open = await linkedRentalOrder();
    expect(open.link.sessions[0]!.manualCapture).toBe(false);
    expect(open.order.payment.capture).toBeNull();
    const paid = await linkedRentalOrder();
    const settled = await deliver(DEPLOYMENT_ENDPOINT, checkoutCompletedFor(paid.order, "paid"), secret);
    expect(settled.body.data).toMatchObject({ handled: true, duplicate: false, orderId: paid.created.id });
    expect((await storedOrder(paid.created.id)).status).toBe(OrderStatus.PAID);
    const paidBefore = await rawOrder(paid.created.id);
    const openBefore = await rawOrder(open.created.id);

    // The switch.
    await setCaptureMode("rc", CaptureMode.MANUAL);
    expect(await rawOrder(paid.created.id)).toEqual(paidBefore);
    expect(await rawOrder(open.created.id)).toEqual(openBefore);

    // "Generate payment link" again on the open order: the same session.
    const again = await generateLink("rc", open.created.id);
    expect(again.status, JSON.stringify(again.json)).toBe(200);
    expect(again.data!.alreadyInitiated).toBe(true);
    expect(again.data!.checkoutUrl).toBe(open.order.payment.paymentUrl);
    expect(again.order!.payment.paymentSessionId).toBe(open.order.payment.paymentSessionId);
    expect(again.order!.payment.capture).toBeNull();
    expect(again.sessions).toEqual([]);
    expect(again.stripeKeys).toEqual([]);
    expect(await rawOrder(open.created.id)).toEqual(openBefore);
    const heldSession = getCurrentTestStripe().sessionsCreated.find(
      (s) => s.result.id === open.order.payment.paymentSessionId,
    );
    expect(heldSession, "the open order's session was never created").toBeTruthy();
    expect(heldSession!.manualCapture).toBe(false);
    expect(Object.keys(heldSession!.params.payment_intent_data ?? {})).not.toContain("capture_method");

    // A NEW order after the switch IS manual — the switch took effect.
    const fresh = await linkedRentalOrder();
    expect(fresh.link.sessions[0]!.manualCapture).toBe(true);
    expect(fresh.order.payment.capture?.status).toBe(PaymentCaptureStatus.PENDING_AUTHORIZATION);

    // The customer pays on the open automatic link.
    const paidNow = await deliver(DEPLOYMENT_ENDPOINT, checkoutCompletedFor(open.order, "paid"), secret);
    expect(paidNow.status, JSON.stringify(paidNow.body)).toBe(200);
    expect(paidNow.body.data).toEqual({
      received: true,
      handled: true,
      duplicate: false,
      orderId: open.created.id,
    });
    const nowPaid = await storedOrder(open.created.id);
    expect(nowPaid.status).toBe(OrderStatus.PAID);
    expect(nowPaid.payment.status).toBe(OrderStatus.PAID);
    expect(nowPaid.payment.amountReceived).toBe(249.99);
    expect(nowPaid.payment.paidAt).toBeInstanceOf(Date);
    expect(nowPaid.payment.capture ?? null).toBeNull();
    expect(nowPaid.bookingStatus ?? null).toBeNull();
    expect(await pendingEmails(open.created.id, EmailKind.PAYMENT_CONFIRMATION)).toBe(1);
    expect(await pendingEmails(open.created.id, EmailKind.PAYMENT_AUTHORIZED)).toBe(0);

    // Neither automatic order can be captured or released.
    for (const id of [open.created.id, paid.created.id]) {
      const capture = await captureVia("rc", id);
      expect(capture.status, JSON.stringify(capture.json)).toBe(409);
      expect(capture.json.error).toEqual({ code: "CONFLICT", message: CHARGED_AT_CHECKOUT });
      expect(capture.captures).toEqual([]);
      const release = await releaseVia("rc", id);
      expect(release.status, JSON.stringify(release.json)).toBe(409);
      expect(release.json.error).toEqual({ code: "CONFLICT", message: CHARGED_AT_CHECKOUT });
      expect(release.cancels).toEqual([]);
    }
    expect(await rawOrder(paid.created.id)).toEqual(paidBefore);
  }, 60_000);
});

/* ================================================================== *
 * D5. CAR REGRESSION — RENTAL ON AUTOMATIC
 * ================================================================== */

describe("D5. CAR REGRESSION — Rental on AUTOMATIC, as production runs today", () => {
  it("D5a. the car order's Stripe session is byte-for-byte the characterization payload ('Budget • Toyota Camry rental', unit_amount 24999, order:<id>:checkout, NO capture_method key at all) on the deployment key; payment.capture null; capture and release answer 409 'charged at checkout' without touching Stripe or the order", async () => {
    expect((await rawOrg("rc")).payments).not.toHaveProperty("captureMode");
    const { created, link } = await linkedRentalOrder();
    expect(link.stripeKeys).toEqual([env.server.STRIPE_SECRET_KEY]);
    expect(link.sessions).toHaveLength(1);
    const { params, options, manualCapture } = link.sessions[0]!;
    expect(normalise(params, idsOf(created))).toEqual(carSessionExpectation(RC.brandName));
    expect(params.line_items![0]!.price_data!.product_data!.name).toBe(`${CAR_SUPPLIER} • Toyota Camry rental`);
    expect(params.line_items![0]!.price_data!.unit_amount).toBe(24999);
    expect(Object.keys(params.payment_intent_data ?? {})).not.toContain("capture_method");
    expect(JSON.stringify(params)).not.toContain("capture_method");
    expect(manualCapture).toBe(false);
    expect(options).toEqual({ idempotencyKey: `order:${created.id}:checkout` });
    expect(link.order!.status).toBe(OrderStatus.LINK_GENERATED);
    expect(link.order!.payment.capture).toBeNull();
    expect(link.order!.bookingStatus).toBeNull();

    const linkedBefore = await rawOrder(created.id);
    const capture = await captureVia("rc", created.id);
    expect(capture.status, JSON.stringify(capture.json)).toBe(409);
    expect(capture.json.error).toEqual({ code: "CONFLICT", message: CHARGED_AT_CHECKOUT });
    expect(capture.captures).toEqual([]);
    expect(capture.stripeKeys).toEqual([]);
    const release = await releaseVia("rc", created.id, "Customer changed plans");
    expect(release.status, JSON.stringify(release.json)).toBe(409);
    expect(release.json.error).toEqual({ code: "CONFLICT", message: CHARGED_AT_CHECKOUT });
    expect(release.cancels).toEqual([]);
    expect(release.stripeKeys).toEqual([]);
    expect(await rawOrder(created.id)).toEqual(linkedBefore);
  }, 60_000);

  it("D5b. capture mode never changes T&C: a car order created while Rental is on MANUAL freezes exactly the deployment's car terms and policy (text and version) that one created on AUTOMATIC froze — the seeded text (recorded finding: its first clause reads 'The prepaid amount is charged today…', unlike the built-in flight / hotel terms' authorized-(held) clause) and, after an admin edits it, the edited text; generating the links changes neither", async () => {
    const legalOf = async (id: string) => {
      const doc = await storedOrder(id);
      return {
        terms: { text: doc.terms.text, version: doc.terms.version },
        policy: { text: doc.policy.text, version: doc.policy.version },
      };
    };

    // The deployment's seeded car text (what Rental, with no legal of its
    // own, freezes onto every car order).
    const onAutomatic = await submitOrder("rc", carBody());
    await setCaptureMode("rc", CaptureMode.MANUAL);
    const onManual = await submitOrder("rc", carBody());
    const seeded = {
      terms: { text: DEFAULT_TERMS_AND_CONDITIONS, version: "v1" },
      policy: { text: DEFAULT_CANCELLATION_POLICY, version: "v1" },
    };
    expect(await legalOf(onAutomatic.id)).toEqual(seeded);
    expect(await legalOf(onManual.id)).toEqual(seeded);
    expect(onManual.terms).toEqual(onAutomatic.terms);
    // THE RECORDED FINDING: frozen onto an order whose checkout only places a
    // hold, the car terms still promise a charge today. The built-in flight
    // and hotel terms already carry the authorized-(held) clause.
    expect(onManual.terms.text).toContain("The prepaid amount is charged today to secure your reservation.");
    // ("licence-held requirements" is the driver's licence, not a hold.)
    expect(onManual.terms.text).not.toMatch(/authori[sz]ed|(?<!licence-)\bheld\b/i);
    expect(DEFAULT_FLIGHT_TERMS_AND_CONDITIONS).toContain(
      "If your card is authorized (held) rather than charged, it is collected only once your booking is confirmed.",
    );
    expect(DEFAULT_HOTEL_TERMS_AND_CONDITIONS).toContain(
      "If your card is authorized (held) rather than charged, it is collected only once your booking is confirmed.",
    );

    // An admin edits the deployment's car text: the next order — still on
    // MANUAL — freezes the EDITED text; the two above keep theirs.
    const TERMS = "RENTAL CAR TERMS MARKER — the deployment's car rental terms, clause one.";
    const POLICY = "RENTAL CAR POLICY MARKER — the deployment's car cancellation rule one.";
    await createSettings({
      termsAndConditions: TERMS,
      termsVersion: "v7",
      cancellationPolicy: POLICY,
      cancellationPolicyVersion: "v4",
    });
    const afterEdit = await submitOrder("rc", carBody());
    expect(await legalOf(afterEdit.id)).toEqual({
      terms: { text: TERMS, version: "v7" },
      policy: { text: POLICY, version: "v4" },
    });
    await setCaptureMode("rc", null);
    const afterEditAutomatic = await submitOrder("rc", carBody());
    expect(await legalOf(afterEditAutomatic.id)).toEqual(await legalOf(afterEdit.id));

    // Generating the links — manual on MANUAL, automatic back on AUTOMATIC —
    // re-freezes nothing.
    await setCaptureMode("rc", CaptureMode.MANUAL);
    const linkManual = await generateLink("rc", onManual.id);
    expect(linkManual.sessions[0]!.manualCapture).toBe(true);
    await setCaptureMode("rc", null);
    const linkAutomatic = await generateLink("rc", onAutomatic.id);
    expect(linkAutomatic.sessions[0]!.manualCapture).toBe(false);
    expect(await legalOf(onAutomatic.id)).toEqual(seeded);
    expect(await legalOf(onManual.id)).toEqual(seeded);
  }, 60_000);

  it("D5c. the payment request for a Rental car order: AUTOMATIC is the car request as pinned (car rows, 'You pay today $249.99', 'Review & Confirm Booking', Rental Confirmation, Stripe); MANUAL is that SAME email — composer preview, sent HTML and plain text — with exactly its money words re-worded for a HOLD ('Card hold today $249.99', 'What you'll be charged', 'authorize your card', 'a hold, not a charge', 'payment request' footer) and nothing else changed: same subject, sender, transport, rows and frozen car terms", async () => {
    // Both bookings on the SAME fixed dates — far from any due date the
    // neutralising below rewrites — so only order-specific values vary.
    const trip = {
      pickupDate: "2031-03-12T15:00:00.000Z",
      dropoffDate: "2031-03-15T15:00:00.000Z",
      pickupLocation: "LAX Airport — Terminal 1",
      dropoffLocation: "San Diego Downtown",
    };
    const onAutomatic = await submitOrder("rc", carBody({ trip }));
    const linkA = await generateLink("rc", onAutomatic.id);
    expect(linkA.sessions[0]!.manualCapture).toBe(false);
    const previewA = await composerPreview("rc", onAutomatic.id);
    const sentA = await sendRequest("rc", onAutomatic.id);

    await setCaptureMode("rc", CaptureMode.MANUAL);
    const onManual = await submitOrder("rc", carBody({ trip }));
    const linkB = await generateLink("rc", onManual.id);
    expect(linkB.sessions[0]!.manualCapture).toBe(true);
    expect(linkB.order!.payment.capture?.status).toBe(PaymentCaptureStatus.PENDING_AUTHORIZATION);
    const previewB = await composerPreview("rc", onManual.id);
    const sentB = await sendRequest("rc", onManual.id);

    /** Everything that is the ORDER's own and not the capture mode's —
     *  bracketed, since angle brackets would read as tags once the HTML is
     *  reduced to the text a reader sees. */
    const neutral = (content: string, order: OrderDTO, consentToken: string) => {
      let out = content;
      const swap = (needle: string | null | undefined, label: string) => {
        if (needle) out = out.split(needle).join(label);
      };
      swap(consentToken, "[CONSENT_TOKEN]");
      swap(encodeURIComponent(consentToken), "[CONSENT_TOKEN]");
      swap(order.payment.paymentSessionId, "[SESSION_ID]");
      swap(order.payment.paymentIntentId, "[PAYMENT_INTENT_ID]");
      swap(order.id, "[ORDER_ID]");
      swap(order.orderNumber, "[ORDER_NUMBER]");
      if (order.payment.expiresAt) {
        const due = formatEmailDate(order.payment.expiresAt);
        swap(due, "[DUE]");
        swap(encodeURIComponent(due), "[DUE]");
      }
      return out;
    };
    const a = (s: string) => neutral(s, linkA.order!, sentA.consentToken);
    const b = (s: string) => neutral(s, linkB.order!, sentB.consentToken);

    // The AUTOMATIC reference is the car request as it has always been.
    const on = onAutomatic.orderNumber;
    expect(sentA.email.subject).toBe(`Complete your ${CAR_SUPPLIER} payment • ${on}`);
    for (const [where, html] of Object.entries({ "composer preview": previewA, "payment request": sentA.email.html })) {
      const read = visibleText(html);
      expect(read, where).toContain(CAR_REQUEST_ROWS);
      expect(read, where).toContain(`You pay today $249.99 Order ${on}`);
      expect(read, where).toContain("Review & Confirm Booking");
      expect(read, where).toContain(`${RC.brandName} Payment requested`);
      expect(read, where).toContain(
        "Payment processed securely via Stripe. Your card details are encrypted end-to-end",
      );
      expect(html, where).toContain(`mailto:${RC.supportEmail}`);
    }
    expect(sentA.email.from).toBe(env.server.EMAIL_FROM);
    expect(sentA.email.transport).toBe("deployment");
    expect(sentA.email.to).toBe("ada@payops.test");

    /**
     * The MANUAL request is the AUTOMATIC one with exactly these words
     * changed — each found where the car request has always printed it —
     * and nothing else: a checkout that only AUTHORIZES must never tell the
     * customer they pay today, nor call its email a receipt.
     */
    const HOLD_WORDING: { from: string; to: string; inText: boolean }[] = [
      // The inbox preview line (hidden in the body; not in the text part).
      {
        from: "Complete payment for [ORDER_NUMBER] — $249.99",
        to: "Authorize your card for [ORDER_NUMBER] — $249.99 on hold, not charged yet",
        inText: false,
      },
      {
        from: "please complete payment using the secure link below to confirm it.",
        to: "please authorize your card using the secure link below to confirm it. You won't be charged until your rental is confirmed.",
        inText: true,
      },
      {
        from: "You pay today $249.99",
        to: `Card hold today $249.99 A hold on your card, not a charge — we charge it only once your rental is confirmed with ${CAR_SUPPLIER}.`,
        inText: true,
      },
      { from: "What you're paying", to: "What you'll be charged", inText: true },
      { from: "Amount paid online $249.99", to: "Card hold today $249.99", inText: true },
      {
        from: "Payment processed securely via Stripe.",
        to: "Card authorized securely via Stripe — a hold, not a charge.",
        inText: true,
      },
      {
        from: "Automated payment receipt — replies route to our support team.",
        to: "Automated payment request — replies route to our support team.",
        inText: true,
      },
    ];
    // The text part upper-cases headings ("WHAT YOU'RE PAYING"); a heading
    // re-worded there is re-worded in capitals too.
    const reworded = (read: string, part: "html" | "text", where: string) => {
      let out = read;
      for (const { from, to, inText } of HOLD_WORDING) {
        if (part === "text" && !inText) continue;
        const needle = part === "text" && !out.includes(from) ? from.toUpperCase() : from;
        expect(out.split(needle).length - 1, `${where}: '${from}' printed once`).toBe(1);
        out = out.replace(needle, needle === from ? to : to.toUpperCase());
      }
      return out;
    };

    // The raw emails DO differ — order number, session, consent link — so
    // nothing here compares a string with itself.
    expect(sentB.email.html).not.toBe(sentA.email.html);
    expect(
      firstDifference(reworded(visibleText(a(previewA)), "html", "composer preview"), visibleText(b(previewB))),
      "composer preview",
    ).toBe("(identical)");
    expect(
      firstDifference(reworded(visibleText(a(sentA.email.html)), "html", "sent HTML"), visibleText(b(sentB.email.html))),
      "sent HTML",
    ).toBe("(identical)");
    expect(
      firstDifference(reworded(plainText(a(sentA.email.text)), "text", "sent text"), plainText(b(sentB.email.text))),
      "sent text",
    ).toBe("(identical)");
    expect(b(sentB.email.subject)).toBe(a(sentA.email.subject));
    expect(sentB.email.from).toBe(sentA.email.from);
    expect(sentB.email.replyTo).toBe(sentA.email.replyTo);
    expect(sentB.email.transport).toBe(sentA.email.transport);
    expect(sentB.email.to).toBe(sentA.email.to);

    const manualRead = visibleText(sentB.email.html);
    expect(manualRead).toContain(`Card hold today $249.99 A hold on your card, not a charge`);
    expect(manualRead).toContain(
      "What you'll be charged Rental cost $249.99 Deposit (due at counter) $100.00 " +
        "Card hold today $249.99 Amount due at counter $100.00 Total rental cost $349.99",
    );
    for (const said of ["You pay today", "Amount paid online", "What you're paying", "Payment processed securely", "payment receipt"]) {
      expect(manualRead, said).not.toContain(said);
      expect(plainText(sentB.email.text), said).not.toContain(said);
    }
    // NOT re-worded, by design: the car Terms & Conditions are the
    // operator's legal text, frozen on the order. The deployment default
    // still says the prepaid amount "is charged today" — changing that is a
    // legal-copy decision for the owner (Settings → Terms & Conditions),
    // never a side effect of the capture mode.
    expect(manualRead).toContain("The prepaid amount is charged today to secure your reservation.");
    const frozen = async (id: string) => {
      const doc = await storedOrder(id);
      return {
        terms: { text: doc.terms.text, version: doc.terms.version },
        policy: { text: doc.policy.text, version: doc.policy.version },
      };
    };
    expect(await frozen(onManual.id)).toEqual(await frozen(onAutomatic.id));
  }, 60_000);
});

/* ================================================================== *
 * D6. TRIPRESERVATIONS REGRESSION
 * ================================================================== */

describe("D6. TRIPRESERVATIONS — as production (PayPal default + Stripe enabled, NO capture mode), unchanged beside a MANUAL Rental", () => {
  it("D6. with Rental on MANUAL, TripReservations still reads AUTOMATIC: its Stripe car link is the automatic car payload on its own key (no capture_method, order:<id>:checkout, capture null) and its capture route answers 409 'charged at checkout'; its PayPal default (the bare body) is ONE PayPal order on its own PayPal account and never a Stripe session — no Stripe client requested", async () => {
    await setCaptureMode("rc", CaptureMode.MANUAL);
    const stored = await rawOrg("trip");
    expect(stored.payments).toMatchObject({
      provider: PaymentGatewayKey.PAYPAL,
      enabledProviders: [PaymentGatewayKey.PAYPAL, PaymentGatewayKey.STRIPE],
    });
    expect(stored.payments).not.toHaveProperty("captureMode");
    expect(await getOrganizationCaptureMode(String(orgIds.trip))).toBe(CaptureMode.AUTOMATIC);
    expect(await getOrganizationCaptureMode(String(orgIds.rc))).toBe(CaptureMode.MANUAL);

    // Stripe, chosen in the composer.
    const onStripe = await submitOrder("trip", carBody());
    const link = await generateLink("trip", onStripe.id, { gateway: PaymentGatewayKey.STRIPE });
    expect(link.status, JSON.stringify(link.json)).toBe(200);
    expect(link.order!.payment.gateway).toBe(PaymentGatewayKey.STRIPE);
    expect(link.stripeKeys).toEqual([TRIP_STRIPE_SECRET_KEY]);
    expect(link.sessions).toHaveLength(1);
    const { params, options, manualCapture } = link.sessions[0]!;
    expect(manualCapture).toBe(false);
    expect(Object.keys(params.payment_intent_data ?? {})).not.toContain("capture_method");
    expect(normalise(params, idsOf(onStripe))).toEqual(carSessionExpectation(TRIP.brandName));
    expect(options).toEqual({ idempotencyKey: `order:${onStripe.id}:checkout` });
    expect(link.order!.payment.capture).toBeNull();
    expect(link.order!.bookingStatus).toBeNull();
    expect(link.paypalFetches).toBe(0);

    const refused = await captureVia("trip", onStripe.id);
    expect(refused.status, JSON.stringify(refused.json)).toBe(409);
    expect(refused.json.error).toEqual({ code: "CONFLICT", message: CHARGED_AT_CHECKOUT });
    expect(refused.captures).toEqual([]);
    expect(refused.stripeKeys).toEqual([]);

    // PayPal, its default.
    const onPayPal = await submitOrder("trip", carBody());
    const pp = await generateLink("trip", onPayPal.id, {});
    expect(pp.status, JSON.stringify(pp.json)).toBe(200);
    expect(pp.order!.payment.gateway).toBe(PaymentGatewayKey.PAYPAL);
    expect(pp.sessions).toEqual([]);
    expect(pp.stripeKeys).toEqual([]);
    expect(pp.paypal).toHaveLength(1);
    expect(pp.paypal[0]!.purchase_units[0]!.amount).toEqual({ currency_code: "USD", value: "249.99" });
    expect(pp.paypal[0]!.purchase_units[0]!.custom_id).toBe(onPayPal.id);
    expect(pp.paypal[0]!.payment_source.paypal.experience_context.brand_name).toBe(TRIP.brandName);
    expect(paypalClientIds).toEqual(["tripreservations-client-id"]);
    expect(pp.order!.payment.capture).toBeNull();
    const refusedPayPal = await captureVia("trip", onPayPal.id);
    expect(refusedPayPal.status, JSON.stringify(refusedPayPal.json)).toBe(409);
    expect(refusedPayPal.json.error).toEqual({ code: "CONFLICT", message: CHARGED_AT_CHECKOUT });

    // Only the one Stripe session above ever reached Stripe.
    expect(getCurrentTestStripe().sessionsCreated).toHaveLength(1);
  }, 60_000);
});

/* ================================================================== *
 * D7. EMAILS — RENTAL ON MANUAL
 * ================================================================== */

describe("D7. EMAILS — Rental on MANUAL: the authorization notice and the receipt under Rental's identity, nothing on release", () => {
  it("D7. the authorization email goes out once under the deployment identity (EMAIL_FROM, deployment transport, 'Rental Confirmation', its support contacts) — 'Budget card authorized — not yet charged • <order>', Amount authorized $249.99 / Amount due at counter $100.00 / Total rental cost $349.99; the capture sends exactly one PAYMENT_CONFIRMATION (Stripe's payment_intent.succeeded that follows adds none); a release sends nothing, nor does the payment_intent.canceled that follows it", async () => {
    await setCaptureMode("rc", CaptureMode.MANUAL);
    const secret = env.server.STRIPE_WEBHOOK_SECRET;
    const expectedReplyTo = env.server.EMAIL_REPLY_TO ? env.server.EMAIL_REPLY_TO : null;

    // ---- authorized → captured ----
    const journey = await linkedRentalOrder();
    const on = journey.created.orderNumber;
    await deliver(DEPLOYMENT_ENDPOINT, checkoutCompletedFor(journey.order, "unpaid"), secret);
    let mark = sentMail.length;
    expect(await drainPendingEmails(10)).toEqual({ processed: 1, sent: 1, failed: 0, retried: 0 });
    expect(sentMail.slice(mark)).toHaveLength(1);
    const held = onlySentSince(mark, EmailKind.PAYMENT_AUTHORIZED);
    expect(held.subject).toBe(`${CAR_SUPPLIER} card authorized — not yet charged • ${on}`);
    expect(held.to).toBe("ada@payops.test");
    expect(held.from).toBe(env.server.EMAIL_FROM);
    expect(held.replyTo).toBe(expectedReplyTo);
    expect(held.transport).toBe("deployment");
    const heldText = visibleText(held.html);
    expect(heldText).toContain(CAR_AUTHORIZED_ROWS);
    expect(heldText).toContain(`We're confirming your rental with ${CAR_SUPPLIER}.`);
    expect(heldText).toContain("Authorization held securely by Stripe — PCI-DSS Level 1 certified.");
    expect(heldText).toContain(`${RC.brandName}. Automated`);
    expect(held.html).toContain(`mailto:${RC.supportEmail}`);
    expect(held.html).toContain(`tel:${RC.supportPhone}`);
    expect(plainText(held.text)).toContain("Amount authorized $249.99");
    expect(plainText(held.text)).toContain("Amount due at counter $100.00");
    expect(plainText(held.text)).toContain("Total rental cost $349.99");
    for (const content of [held.html, held.text, held.subject]) {
      expect(content).not.toContain(TRIP.brandName);
      expect(content).not.toMatch(/paypal/i);
    }

    const captured = await captureVia("rc", journey.created.id);
    expect(captured.status, JSON.stringify(captured.json)).toBe(200);
    mark = sentMail.length;
    expect(await drainPendingEmails(10)).toEqual({ processed: 1, sent: 1, failed: 0, retried: 0 });
    const receipt = onlySentSince(mark, EmailKind.PAYMENT_CONFIRMATION);
    expect(sentMail.slice(mark)).toHaveLength(1);
    expect(receipt.subject).toBe(`${CAR_SUPPLIER} booking confirmed • ${on}`);
    expect(receipt.from).toBe(env.server.EMAIL_FROM);
    expect(receipt.transport).toBe("deployment");
    const receiptText = visibleText(receipt.html);
    expect(receiptText).toContain(CAR_RECEIPT_ROWS);
    expect(receiptText).toContain(`Amount paid $249.99 Order ${on}`);
    expect(receiptText).toContain("Payment processed securely by Stripe — PCI-DSS Level 1 certified.");
    expect(receiptText).toContain(`${RC.brandName}. Automated`);

    // Stripe's own payment_intent.succeeded for that capture: a duplicate.
    const followUp = await deliver(DEPLOYMENT_ENDPOINT, succeededFor(journey.order), secret);
    expect(followUp.body.data).toMatchObject({ handled: true, duplicate: true });
    mark = sentMail.length;
    expect(await drainPendingEmails(10)).toEqual({ processed: 0, sent: 0, failed: 0, retried: 0 });
    expect(sentMail.length).toBe(mark);
    expect(await pendingEmails(journey.created.id, EmailKind.PAYMENT_CONFIRMATION)).toBe(1);
    expect(await pendingEmails(journey.created.id, EmailKind.PAYMENT_AUTHORIZED)).toBe(1);

    // ---- authorized → released ----
    const released = await linkedRentalOrder();
    await deliver(DEPLOYMENT_ENDPOINT, capturableFor(released.order), secret);
    mark = sentMail.length;
    expect((await drainPendingEmails(10)).sent).toBe(1);
    expect(onlySentSince(mark, EmailKind.PAYMENT_AUTHORIZED).subject).toBe(
      `${CAR_SUPPLIER} card authorized — not yet charged • ${released.created.orderNumber}`,
    );
    const queuedBefore = await PendingEmail.countDocuments({});
    const release = await releaseVia("rc", released.created.id, "Supplier could not confirm");
    expect(release.status, JSON.stringify(release.json)).toBe(200);
    expect(release.order!.payment.capture?.status).toBe(PaymentCaptureStatus.CANCELLED);
    expect(release.order!.bookingStatus).toBe(BookingStatus.CANCELLED);
    expect(await PendingEmail.countDocuments({})).toBe(queuedBefore);
    mark = sentMail.length;
    expect(await drainPendingEmails(10)).toEqual({ processed: 0, sent: 0, failed: 0, retried: 0 });
    expect(sentMail.length).toBe(mark);
    // Stripe's payment_intent.canceled for that release (reason "abandoned",
    // what the release sent): already released — nothing changes, nothing sent.
    const cancelFollowUp = await deliver(DEPLOYMENT_ENDPOINT, canceledFor(released.order, "abandoned"), secret);
    expect(cancelFollowUp.body.data).toMatchObject({ handled: true, duplicate: true });
    expect((await storedOrder(released.created.id)).payment.capture?.status).toBe(
      PaymentCaptureStatus.CANCELLED,
    );
    expect(await PendingEmail.countDocuments({})).toBe(queuedBefore);
    expect(await drainPendingEmails(10)).toEqual({ processed: 0, sent: 0, failed: 0, retried: 0 });
    expect(sentMail.length).toBe(mark);
  }, 60_000);
});

/* ================================================================== *
 * D8. EVENT-LIST CONSISTENCY
 * ================================================================== */

describe("D8. EVENT LIST — every MANUAL_CAPTURE_STRIPE_EVENTS entry is an event the app handles", () => {
  it("D8. a minimal realistic payload for each listed event, signed with the deployment secret and verified by Rental's own gateway (the deployment one), normalises to a handled type — never 'unhandled' — and at POST /api/webhooks/stripe reaches a handler (never 'unhandled_event'); an unlisted event and an AUTOMATIC payment_intent.succeeded stay unhandled", async () => {
    await setCaptureMode("rc", CaptureMode.MANUAL);
    const secret = env.server.STRIPE_WEBHOOK_SECRET;
    // A Rental manual order, authorized and captured — the state a refund or
    // a dispute finds it in.
    const { created, order } = await linkedRentalOrder();
    await deliver(DEPLOYMENT_ENDPOINT, checkoutCompletedFor(order, "unpaid"), secret);
    expect((await captureVia("rc", created.id)).status).toBe(200);
    const pi = order.payment.paymentIntentId!;
    const nowSeconds = Math.floor(Date.now() / 1000);

    const wrap = (type: string, object: Record<string, unknown>): Stripe.Event =>
      ({
        id: `evt_d8_${type.replace(/\W/g, "_")}_${nowSeconds}`,
        object: "event",
        api_version: "2024-06-20",
        created: nowSeconds,
        type,
        livemode: false,
        pending_webhooks: 1,
        request: { id: null, idempotency_key: null },
        data: { object },
      }) as unknown as Stripe.Event;
    const dispute = (type: string, status: string) =>
      wrap(type, {
        id: "du_d8_rental",
        object: "dispute",
        charge: "ch_d8_rental",
        payment_intent: pi,
        amount: 24999,
        currency: "usd",
        reason: "fraudulent",
        status,
        evidence_details: { due_by: nowSeconds + 7 * 86_400 },
      });
    const paymentFailed = buildPaymentIntentFailed({ paymentIntentId: pi, message: "Your card was declined." });
    Object.assign(paymentFailed.data.object, {
      capture_method: "manual",
      metadata: { orderId: created.id, orderNumber: created.orderNumber },
    });

    const PAYLOADS: Record<string, { event: Stripe.Event; normalised: PaymentEventType }> = {
      "checkout.session.completed": { event: checkoutCompletedFor(order, "unpaid"), normalised: "payment.authorized" },
      "checkout.session.expired": {
        event: buildCheckoutExpired({
          orderId: created.id,
          orderNumber: created.orderNumber,
          sessionId: order.payment.paymentSessionId!,
        }),
        normalised: "checkout.expired",
      },
      "payment_intent.amount_capturable_updated": { event: capturableFor(order), normalised: "payment.authorized" },
      "payment_intent.succeeded": { event: succeededFor(order), normalised: "payment.captured" },
      "payment_intent.canceled": { event: canceledFor(order, "automatic"), normalised: "payment.cancelled" },
      "payment_intent.payment_failed": { event: paymentFailed, normalised: "payment.failed" },
      "charge.refunded": {
        event: wrap("charge.refunded", {
          id: "ch_d8_rental",
          object: "charge",
          payment_intent: pi,
          amount: 24999,
          amount_refunded: 24999,
          currency: "usd",
          metadata: { orderId: created.id },
          refunds: {
            object: "list",
            data: [{ id: "re_d8_rental", object: "refund", amount: 24999, reason: "requested_by_customer" }],
          },
        }),
        normalised: "refund.created",
      },
      "charge.dispute.created": { event: dispute("charge.dispute.created", "needs_response"), normalised: "dispute.created" },
      "charge.dispute.updated": { event: dispute("charge.dispute.updated", "under_review"), normalised: "dispute.updated" },
      "charge.dispute.closed": { event: dispute("charge.dispute.closed", "won"), normalised: "dispute.closed" },
      "charge.dispute.funds_withdrawn": {
        event: dispute("charge.dispute.funds_withdrawn", "needs_response"),
        normalised: "dispute.funds_withdrawn",
      },
    };

    const gateway = await getGatewayForOrganization(String(orgIds.rc));
    expect(gateway).toBe(getDefaultGateway());
    const verify = async (event: Stripe.Event) => {
      const payload = JSON.stringify(event);
      return gateway.verifyWebhook(
        payload,
        new Headers({ "stripe-signature": signWebhook(payload, secret) }),
      );
    };

    expect(MANUAL_CAPTURE_STRIPE_EVENTS.length).toBeGreaterThan(0);
    expect(new Set(MANUAL_CAPTURE_STRIPE_EVENTS).size).toBe(MANUAL_CAPTURE_STRIPE_EVENTS.length);
    for (const type of MANUAL_CAPTURE_STRIPE_EVENTS) {
      const spec = PAYLOADS[type];
      expect(spec, `no realistic payload for listed event ${type}`).toBeDefined();
      expect(spec!.event.type).toBe(type);
      const verified = await verify(spec!.event);
      expect(verified.type, type).not.toBe("unhandled");
      expect(verified.type, type).toBe(spec!.normalised);
    }
    // Every payload above is for a LISTED event — none is a stray extra.
    expect(Object.keys(PAYLOADS).sort()).toEqual([...MANUAL_CAPTURE_STRIPE_EVENTS].sort());

    // The controls: the same check CAN say "unhandled".
    const unlisted = await verify(wrap("payment_intent.created", { id: pi, object: "payment_intent", capture_method: "manual", metadata: {} }));
    expect(unlisted.type).toBe("unhandled");
    const automaticSucceeded = await verify(succeededFor(order, "automatic"));
    expect(automaticSucceeded.type).toBe("unhandled");

    // Through the deployment endpoint: each listed event reaches a handler.
    for (const type of MANUAL_CAPTURE_STRIPE_EVENTS) {
      const reply = await deliver(DEPLOYMENT_ENDPOINT, PAYLOADS[type]!.event, secret);
      expect(reply.status, `${type}: ${JSON.stringify(reply.body)}`).toBe(200);
      expect(reply.body.data.received, type).toBe(true);
      expect(reply.body.data.reason, `${type}: ${JSON.stringify(reply.body.data)}`).not.toBe("unhandled_event");
    }
    const strayReply = await deliver(
      DEPLOYMENT_ENDPOINT,
      wrap("payment_intent.created", { id: pi, object: "payment_intent", capture_method: "manual", metadata: {} }),
      secret,
    );
    expect(strayReply.body.data).toEqual({
      received: true,
      handled: false,
      duplicate: false,
      reason: "unhandled_event",
    });
    // None of it was mistaken for another organization's.
    expect(await crossOrgRefusals()).toEqual([]);
  }, 60_000);
});

/* ================================================================== *
 * D9. THE SWITCH — THE REAL SCRIPT, FOR THE DEFAULT ORGANIZATION
 * ================================================================== */

describe("D9. THE SWITCH — scripts/set-organization-capture-mode.ts run for rentalconfirmation, as its header documents", () => {
  it("D9. the dry run reports the DEFAULT organization's own AND unattributed orders (both pre-migration shapes — organizationId null and no key at all — among '3 not yet initiated', TripReservations' not counted), names the DEPLOYMENT endpoint <APP_URL>/api/webhooks/stripe and every MANUAL_CAPTURE_STRIPE_EVENTS entry, and writes nothing; APPLY=1 writes payments.captureMode MANUAL and nothing else; what it reported then holds — the legacy and the stamped order's first links are manual, the open charge-at-checkout link stays automatic", async () => {
    // Rental's orders: one stamped and two unattributed (organizationId null,
    // and no such key at all), none initiated, and one with an open
    // charge-at-checkout link. Plus one of TripReservations', which is not
    // Rental's to count.
    const stamped = await submitOrder("rc", carBody());
    const legacy = await legacyCarOrder();
    const legacyNoKey = await legacyCarOrder("absent");
    const open = await linkedRentalOrder();
    expect(open.link.sessions[0]!.manualCapture).toBe(false);
    await submitOrder("trip", carBody());
    const before = { rc: await rawOrg("rc"), trip: await rawOrg("trip") };

    // Dry run (the knob's case and spacing are normalised by the script).
    const dry = await runSetCaptureMode({ ORG_SLUG: RC.slug, CAPTURE_MODE: " manual " });
    expect(dry.exitCode, `${dry.stdout}\n${dry.stderr}`).toBe(0);
    const lines = dry.stdout.split(/\r?\n/).map((l) => l.trimEnd());
    expect(lines).toContain(
      `→ Setting the capture mode of organization "${RC.slug}" to MANUAL (dry run — set APPLY=1 to write)`,
    );
    expect(lines).toContain(
      `  • organization   ${RC.brandName} (${RC.slug}, ${String(orgIds.rc)}, ACTIVE, default)`,
    );
    expect(lines).toContain("  • stored         (none stored — reads as AUTOMATIC)");
    expect(lines).toContain("  • before         AUTOMATIC");
    expect(lines).toContain("  • after          MANUAL");
    expect(lines).toContain("  • gateways       STRIPE");
    expect(lines).toContain("    – 3 not yet initiated: their first payment link uses MANUAL");
    expect(lines).toContain(
      "    – 1 with an open charge-at-checkout link: that link keeps charging at checkout. Don't regenerate these until it has expired",
    );
    expect(lines).toContain(
      `  • Stripe webhook endpoint (this organization's Stripe account): <APP_URL>${DEPLOYMENT_ENDPOINT}`,
    );
    for (const event of MANUAL_CAPTURE_STRIPE_EVENTS) {
      expect(lines, `the report omits ${event}`).toContain(`      ${event}`);
    }
    expect(lines).toContain("  • dry run: no writes made");
    expect(dry.stdout).not.toContain("✓ stored");
    expect(await rawOrg("rc")).toEqual(before.rc);
    expect(await getOrganizationCaptureMode(null)).toBe(CaptureMode.AUTOMATIC);

    // APPLY=1.
    const applied = await runSetCaptureMode({ ORG_SLUG: RC.slug, CAPTURE_MODE: "MANUAL", APPLY: "1" });
    expect(applied.exitCode, `${applied.stdout}\n${applied.stderr}`).toBe(0);
    expect(applied.stdout).toContain(`→ Setting the capture mode of organization "${RC.slug}" to MANUAL\n`);
    expect(applied.stdout).toContain("  ✓ stored MANUAL");
    expect(applied.stdout).toContain("✔ Organization capture mode updated.");
    // Narrow: `payments.captureMode` (and the timestamp) is all it wrote.
    const after = await rawOrg("rc");
    expect(after.payments).toEqual({
      ...(before.rc.payments as Record<string, unknown>),
      captureMode: CaptureMode.MANUAL,
    });
    expect(withoutKeys(after, ["payments", "updatedAt"])).toEqual(
      withoutKeys(before.rc, ["payments", "updatedAt"]),
    );
    expect(after).not.toHaveProperty("serviceTypes");
    expect(after).not.toHaveProperty("legal");
    expect(await rawOrg("trip")).toEqual(before.trip);
    expect(await getOrganizationCaptureMode(null)).toBe(CaptureMode.MANUAL);
    expect(await getOrganizationCaptureMode(String(orgIds.rc))).toBe(CaptureMode.MANUAL);

    // What the report said, true: every uninitiated order's first link is
    // manual — both unattributed shapes included — on the deployment key…
    for (const order of [legacy, legacyNoKey, stamped]) {
      const link = await generateLink("rc", order.id);
      expect(link.status, JSON.stringify(link.json)).toBe(200);
      expect(link.stripeKeys).toEqual([env.server.STRIPE_SECRET_KEY]);
      expect(link.sessions).toHaveLength(1);
      expect(link.sessions[0]!.manualCapture).toBe(true);
      expect(link.sessions[0]!.options).toEqual({ idempotencyKey: `order:${order.id}:checkout:manual` });
      expect(link.order!.payment.capture).toMatchObject({
        method: CaptureMode.MANUAL,
        status: PaymentCaptureStatus.PENDING_AUTHORIZATION,
      });
    }
    expect((await rawOrder(legacy.id)).organizationId).toBeNull();
    expect((await rawOrder(legacyNoKey.id)).organizationId ?? null).toBeNull();
    // …and the open link keeps charging at checkout.
    const again = await generateLink("rc", open.created.id);
    expect(again.status, JSON.stringify(again.json)).toBe(200);
    expect(again.data!.alreadyInitiated).toBe(true);
    expect(again.sessions).toEqual([]);
    expect(again.order!.payment.capture).toBeNull();
  }, 60_000);
});
