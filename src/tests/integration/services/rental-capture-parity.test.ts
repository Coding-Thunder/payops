import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import type Stripe from "stripe";

import { POST as createOrderRoute } from "@/app/api/orders/route";
import { DELETE as archiveOrderRoute } from "@/app/api/orders/[id]/route";
import { POST as cancelAuthorizationRoute } from "@/app/api/orders/[id]/cancel-authorization/route";
import { POST as captureRoute } from "@/app/api/orders/[id]/capture/route";
import { POST as generateLinkRoute } from "@/app/api/orders/[id]/generate-payment-link/route";
import { POST as regenerateLinkRoute } from "@/app/api/orders/[id]/regenerate-link/route";
import { POST as deploymentStripeWebhook } from "@/app/api/webhooks/stripe/route";
import { POST as orgStripeWebhook } from "@/app/api/webhooks/stripe/[orgSlug]/route";
import {
  AuditAction,
  BookingStatus,
  CaptureMode,
  EmailKind,
  OrderEvidenceEventType,
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
  planCaptureMode,
  stripeWebhookPath,
} from "@/lib/organization-capture-mode";
import {
  AuditLog,
  BRANDING_KEY,
  Branding,
  Order,
  OrderEvidence,
  Organization,
  OrganizationCredential,
  OrganizationMember,
  PendingEmail,
} from "@/server/db/models";
import { orgCookieName } from "@/server/auth/org-cookie";
import type { AuthenticatedUser } from "@/server/auth/session";
import { getDefaultGateway } from "@/server/payments/gateways";
import { getGatewayForOrganization } from "@/server/payments/resolve-gateway";
import { getOrganizationCaptureMode } from "@/server/services/order.service";
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
 * RENTAL ↔ REFERENCE PARITY FOR MANUAL CAPTURE: the whole authorize → capture
 * ("Capture payment") / release ("Release hold" — the client's "Uncapture")
 * lifecycle, run on two organizations side by side through the REAL route
 * handlers and the REAL webhook endpoints, and compared outcome for outcome.
 *
 *   REFERENCE  tripreservations     TripReservations-shaped and NOT default:
 *                                   PayPal default with Stripe enabled
 *                                   ([PAYPAL, STRIPE]), sells [CAR_RENTAL,
 *                                   FLIGHT], captureMode MANUAL, its OWN
 *                                   Stripe account (ORG_TRIPRESERVATIONS_
 *                                   STRIPE_* — test values, set per test and
 *                                   removed after). Links are posted
 *                                   { gateway: "STRIPE" }, as the email
 *                                   composer posts them; its events arrive at
 *                                   POST /api/webhooks/stripe/tripreservations
 *                                   signed with its own webhook secret.
 *   RENTAL     rentalconfirmation   the DEFAULT organization exactly as
 *                                   production stores it (Stripe only,
 *                                   enabledProviders [STRIPE]; serviceTypes,
 *                                   legal and payments.captureMode absent — a
 *                                   document older than those fields, which
 *                                   reads AUTOMATIC), switched to MANUAL with
 *                                   the one narrow guarded write
 *                                   scripts/set-organization-capture-mode.ts
 *                                   performs: planCaptureMode on the stored
 *                                   value, then $set "payments.captureMode"
 *                                   guarded on that key still being absent.
 *                                   No ORG_RENTALCONFIRMATION_* env, so it runs
 *                                   on the DEPLOYMENT key (getDefaultGateway());
 *                                   links are posted {} (one gateway); its
 *                                   events arrive at the deployment endpoint
 *                                   POST /api/webhooks/stripe, signed with
 *                                   STRIPE_WEBHOOK_SECRET.
 *
 * Each organization's events are posted to the path `stripeWebhookPath`
 * (src/lib/organization-capture-mode.ts) names for its stored document — the
 * path the script tells the operator to configure in that Stripe account —
 * and every event the matrix delivers must be on MANUAL_CAPTURE_STRIPE_EVENTS,
 * the subscription list the script prints. So the endpoint and the events the
 * operator is told to set up are the ones proven to work here.
 *
 * WHY THE REFERENCE IS TRIPRESERVATIONS-SHAPED. Manual capture is ONE shared,
 * data-driven code path — the one FlightBizz (globevista) runs in production
 * today. The client names TripReservations as the behaviour Rental must
 * match, so the reference is an organization shaped like TripReservations
 * with MANUAL switched on, running that shared path on its own account. Both
 * sides use the same car order (Rental cost $249.99 PREPAID + Deposit $100.00
 * DUE_AT_COUNTER, Budget) created through POST /api/orders by an ADMIN —
 * with STAFF and SUPER_ADMIN where a scenario needs them — who holds ACTIVE
 * memberships in both organizations and has the order's organization
 * selected (the organization cookie).
 *
 * HOW EACH SCENARIO IS PROVEN. One function per scenario, `run(lane)`, drives
 * it for an organization and returns a NORMALISED outcome: for every step the
 * HTTP status and error message, the order the API answered with, the order
 * as stored afterwards, whether the step wrote to the order at all, the
 * Stripe calls made during the step — { method, onTheOrdersPaymentIntent,
 * params, idempotencyKey }, with the order id as <ID>, ids as <CS_n>/<PI_n>
 * and the brand as <BRAND> — and which Stripe account every client was
 * created for; then the PendingEmail rows enqueued for the order by kind,
 * its audit actions and its evidence chain. Every test asserts
 * `expect(rental).toEqual(reference)` AND absolute expectations on the
 * reference outcome, so the two sides cannot be equally wrong.
 *
 *   fixtures  the two organizations are what this header says, and the
 *             switch is one narrow write read on every new link — an order
 *             linked before it stays charge-at-checkout, out of reach of
 *             Capture and Release
 *   S1 link · S2 authorize · S3 capture · S4 capture again · S5 a late
 *   payment_intent.succeeded · S6 release · S7 release again · S8 a late
 *   payment_intent.canceled · S9 stale actions · S10 CAPTURE_PENDING · S11
 *   two captures at once · S12 Stripe refuses the capture, then "Retry
 *   capture" · S13 Stripe refuses the release · S14 the hold expires · S15 a
 *   capture decline · S16 checkout.session.expired while authorized · S17
 *   permissions · S18 regenerate · S19 archived · S20 no intent yet
 *   S21 (beyond the matrix) an order stored WITHOUT an organization — which
 *             belongs to the default organization — runs Rental's lifecycle.
 *             It is also what pins Rental to the DEPLOYMENT endpoint: the
 *             per-organization route would serve Rental's own orders on the
 *             deployment account too, but refuses an unattributed one.
 *
 * The Stripe SDK is the in-process stub (src/tests/mocks/stripe-stub.ts). Its
 * calls are recorded through pass-through spies, and `getStripeFor` is spied
 * the same way: the stub answers for ANY key, so the key a client was created
 * with is what tells the two merchant accounts apart.
 */

/* ------------------------------------------------------------------ *
 * The two organizations
 * ------------------------------------------------------------------ */

type LaneKey = "tripreservations" | "rentalconfirmation";

const TRIP = {
  slug: "tripreservations",
  brandName: "Trip Reservations",
  supportEmail: "contact@tripreservations.test",
} as const;

/** The default organization; the deployment Branding singleton is its own. */
const RENTAL = {
  slug: "rentalconfirmation",
  brandName: "Rental Confirmation",
  supportEmail: "support@rentalconfirmation.com",
  supportPhone: "+15513071441",
} as const;

/** The reference's OWN Stripe account — test values, never used anywhere real. */
const TRIP_STRIPE_SECRET_KEY = "sk_test_tripreservations_parity_only";
const TRIP_STRIPE_WEBHOOK_SECRET = "whsec_tripreservations_parity_only";
const TRIP_STRIPE_ENV: Record<string, string> = {
  ORG_TRIPRESERVATIONS_STRIPE_SECRET_KEY: TRIP_STRIPE_SECRET_KEY,
  ORG_TRIPRESERVATIONS_STRIPE_WEBHOOK_SECRET: TRIP_STRIPE_WEBHOOK_SECRET,
};
/** Rental must have none of its own: it runs on the deployment account. */
const RENTAL_ENV_PREFIX = "ORG_RENTALCONFIRMATION_";

const admin = actorFor(UserRole.ADMIN, { name: "Olivia Operator" });
const staff = actorFor(UserRole.STAFF, { name: "Sam Staff" });
const superAdmin = actorFor(UserRole.SUPER_ADMIN, { name: "Sasha Super" });
const ACTORS = [admin, staff, superAdmin];

const CUSTOMER_EMAIL = "ada@payops.test";
const RELEASE_REASON = "Supplier could not confirm";
const HOLD_MS = 7 * 24 * 60 * 60 * 1000;
const STRIPE_CAPTURE_REFUSAL = {
  code: "payment_intent_unexpected_state",
  message:
    "This PaymentIntent could not be captured because it has a status of requires_payment_method.",
};
const STRIPE_CANCEL_REFUSAL = {
  code: "payment_intent_unexpected_state",
  message:
    "You cannot cancel this PaymentIntent because it has a status of processing.",
};
const CARD_DECLINED = "Your card was declined.";

/** Every operator-facing refusal, verbatim from payment-capture.service.ts,
 *  order.service.ts, lib/errors.ts and the route guards. */
const MSG = {
  chargedAtCheckout:
    "This order was charged at checkout. Capture and release apply only to authorized payments.",
  capturedAlready:
    "This payment has already been captured. Issue a refund instead of releasing the authorization.",
  noIntentYet: "This order has no payment intent to act on yet.",
  anotherCapture: "Another capture is already in progress for this order.",
  archived: "Cannot act on an archived order",
  captureFailed: "Could not capture this payment",
  releaseFailed: "Could not release this authorization",
  notFound: "Order not found",
  liveAuthorization:
    "This order has a live authorization. Release the authorization before generating a new payment link.",
  liveHoldArchive:
    "This order has a live card hold. Capture or release it before archiving.",
  forbidden: "You do not have permission to perform this action",
  unauthenticated: "Authentication required",
  cannotCapture: (status: string) => `Cannot capture — the payment is ${status}.`,
  cannotRelease: (status: string) => `Cannot release — the payment is ${status}.`,
};

/** What a second, concurrent "Capture payment" may legitimately be told. */
const CONCURRENT_REFUSALS = [MSG.anotherCapture, MSG.cannotCapture("capture_pending")];

interface Lane {
  key: LaneKey;
  orgId: Types.ObjectId;
  brandName: string;
  /** What the email composer posts to generate-payment-link. */
  linkBody: Record<string, unknown>;
  /** The secret key every Stripe client of this organization must use. */
  stripeSecretKey: () => string;
  /** Where this organization's Stripe account delivers its events:
   *  `stripeWebhookPath` of the stored organization. */
  webhookPath: string;
  /** A signed Stripe event, to the endpoint this organization's account calls. */
  deliver: (event: Stripe.Event) => Promise<Response>;
  other: () => Lane;
}

const lanes = {} as Record<LaneKey, Lane>;
let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;
let envBefore: Record<string, string | undefined> = {};

async function unsetRaw(orgId: Types.ObjectId, paths: string[]) {
  await Organization.collection.updateOne(
    { _id: orgId },
    { $unset: Object.fromEntries(paths.map((p) => [p, ""])) },
  );
}

async function membershipsIn(orgId: Types.ObjectId) {
  for (const actor of ACTORS) {
    await OrganizationMember.create({
      organizationId: orgId,
      userId: new Types.ObjectId(actor.id),
      role: actor.role,
      status: RecordState.ACTIVE,
    });
  }
}

async function makeTripReservations(): Promise<Types.ObjectId> {
  const doc = await Organization.create({
    slug: TRIP.slug,
    name: TRIP.brandName,
    brandName: TRIP.brandName,
    isDefault: false,
    payments: {
      provider: PaymentGatewayKey.PAYPAL,
      enabledProviders: [PaymentGatewayKey.PAYPAL, PaymentGatewayKey.STRIPE],
      captureMode: CaptureMode.MANUAL,
    },
    serviceTypes: [ServiceType.CAR_RENTAL, ServiceType.FLIGHT],
    email: { fromName: TRIP.brandName, fromEmail: TRIP.supportEmail, replyTo: "" },
    support: { email: TRIP.supportEmail, phone: "" },
  });
  const id = doc._id as Types.ObjectId;
  // No legal text of its own, as in production.
  await unsetRaw(id, ["legal"]);
  await membershipsIn(id);
  return id;
}

async function makeRentalConfirmation(): Promise<Types.ObjectId> {
  const doc = await Organization.create({
    slug: RENTAL.slug,
    name: RENTAL.brandName,
    brandName: RENTAL.brandName,
    isDefault: true,
    payments: {
      provider: PaymentGatewayKey.STRIPE,
      enabledProviders: [PaymentGatewayKey.STRIPE],
    },
    support: { email: RENTAL.supportEmail, phone: RENTAL.supportPhone },
  });
  const id = doc._id as Types.ObjectId;
  // Written before these fields existed: no serviceTypes, no legal, and no
  // capture mode (it reads AUTOMATIC through `?? AUTOMATIC`).
  await unsetRaw(id, ["serviceTypes", "legal", "payments.captureMode"]);
  await membershipsIn(id);
  return id;
}

/** An organization exactly as stored — raw driver, no Mongoose defaults. */
async function rawOrg(orgId: Types.ObjectId): Promise<Record<string, unknown>> {
  const doc = await Organization.collection.findOne({ _id: orgId });
  expect(doc, "organization is missing").toBeTruthy();
  return JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
}

interface StoredPayments {
  provider?: string;
  enabledProviders?: string[];
  captureMode?: unknown;
}

/**
 * `APPLY=1 ORG_SLUG=rentalconfirmation CAPTURE_MODE=MANUAL
 * scripts/set-organization-capture-mode.ts`, step for step: plan the change
 * from the STORED value (`planCaptureMode`, the script's own rule), then one
 * $set of "payments.captureMode" guarded on the value still being what was
 * read — absent or null when none is stored, as production's default
 * organization has it. Raw driver, so nothing but that one key is written.
 */
async function switchRentalToManual() {
  const id = lanes.rentalconfirmation.orgId;
  const payments = (await rawOrg(id)).payments as StoredPayments;
  const stored = payments.captureMode;
  const plan = planCaptureMode({
    stored,
    requested: CaptureMode.MANUAL,
    payments,
    allowAutomatic: false,
  });
  expect(plan, "the script's plan for Rental").toEqual({
    before: CaptureMode.AUTOMATIC,
    after: CaptureMode.MANUAL,
    changes: true,
    // Stripe is Rental's only gateway: nothing keeps charging at checkout.
    unaffectedGateways: [],
  });
  const unchangedSinceRead =
    stored === undefined || stored === null
      ? {
          $or: [
            { "payments.captureMode": { $exists: false } },
            { "payments.captureMode": null },
          ],
        }
      : { "payments.captureMode": stored };
  const res = await Organization.collection.updateOne(
    { _id: id, ...unchangedSinceRead },
    { $set: { "payments.captureMode": plan.after } },
  );
  expect(res.matchedCount, "the guarded switch matched nothing").toBe(1);
}

/* ------------------------------------------------------------------ *
 * The Stripe recorder
 * ------------------------------------------------------------------ */

type StripeMethod =
  | "checkout.sessions.create"
  | "checkout.sessions.expire"
  | "checkout.sessions.retrieve"
  | "paymentIntents.capture"
  | "paymentIntents.cancel"
  | "paymentIntents.retrieve";

type TimelineEntry =
  | { kind: "client"; secretKey: string }
  | { kind: "call"; method: StripeMethod; args: unknown[] };

/** Every Stripe client requested and every Stripe API call, in order. */
const timeline: TimelineEntry[] = [];
/** The next paymentIntents.cancel throws this (recorded first, as the stub's
 *  own failNextCapture records before throwing). */
let nextCancelRefusal: { code: string; message: string } | null = null;

/**
 * Pass-through spies on the stub's API surface and on `getStripeFor`. A
 * refused cancel is staged here rather than with `mockRejectedValueOnce` on
 * the same method: a once-implementation would bypass this recorder, and the
 * outcome would then misreport that no cancel was ever attempted.
 */
async function recordStripe() {
  timeline.length = 0;
  nextCancelRefusal = null;
  const stripe = getCurrentTestStripe().asStripe();
  const surfaces: [unknown, string, StripeMethod][] = [
    [stripe.checkout.sessions, "create", "checkout.sessions.create"],
    [stripe.checkout.sessions, "expire", "checkout.sessions.expire"],
    [stripe.checkout.sessions, "retrieve", "checkout.sessions.retrieve"],
    [stripe.paymentIntents, "capture", "paymentIntents.capture"],
    [stripe.paymentIntents, "cancel", "paymentIntents.cancel"],
    [stripe.paymentIntents, "retrieve", "paymentIntents.retrieve"],
  ];
  for (const [surface, name, method] of surfaces) {
    const target = surface as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const original = target[name]!;
    vi.spyOn(target, name).mockImplementation(async (...args: unknown[]) => {
      timeline.push({ kind: "call", method, args });
      if (method === "paymentIntents.cancel" && nextCancelRefusal) {
        const refusal = nextCancelRefusal;
        nextCancelRefusal = null;
        throw Object.assign(new Error(refusal.message), { code: refusal.code });
      }
      return original(...args);
    });
  }
  const client = await import("@/server/payments/stripe");
  const getStripeFor = client.getStripeFor;
  vi.spyOn(client, "getStripeFor").mockImplementation((secretKey: string) => {
    timeline.push({ kind: "client", secretKey });
    return getStripeFor(secretKey);
  });
}

/** What Stripe reports for a session from now on (sessions.retrieve). */
function stripeNowReports(sessionId: string, status: string, paymentStatus: string) {
  const recorded = getCurrentTestStripe().sessionsCreated.find((s) => s.result.id === sessionId);
  expect(recorded, `Stripe never created ${sessionId}`).toBeTruthy();
  const session = recorded!.result as unknown as { status: string; payment_status: string };
  session.status = status;
  session.payment_status = paymentStatus;
}

/* ------------------------------------------------------------------ *
 * Normalised outcomes
 * ------------------------------------------------------------------ */

interface StripeCall {
  method: StripeMethod;
  /** The session or intent the call names (<CS_n> / <PI_n>); null for a create. */
  target: string | null;
  /** The call names the intent the order held when the step began. Null when
   *  the call names no intent. */
  onTheOrdersPaymentIntent: boolean | null;
  params: unknown;
  idempotencyKey: string | null;
}

/** NONE: no Stripe client at all. OWN: every client on the organization's own
 *  key. FOREIGN: any client on another key — never acceptable. */
type StripeAccount = "NONE" | "OWN" | "FOREIGN";

interface CaptureState {
  method: string;
  status: string;
  amountAuthorized: number | null;
  amountCaptured: number | null;
  authorized: boolean;
  captured: boolean;
  cancelled: boolean;
  /** captureExpiresAt − authorizedAt. */
  holdMs: number | null;
  cancelReason: string | null;
  lastError: string | null;
}

interface OrderState {
  status: string;
  paymentStatus: string;
  state: string;
  gateway: string | null;
  session: string | null;
  paymentIntent: string | null;
  bookingStatus: string | null;
  capture: CaptureState | null;
  amountReceived: number | null;
  paid: boolean;
}

interface DtoSummary {
  status: string;
  paymentStatus: string;
  bookingStatus: string | null;
  gateway: string | null;
  amountReceived: number | null;
  capture: {
    method: string;
    status: string;
    amountAuthorized: number | null;
    amountCaptured: number | null;
    cancelReason: string | null;
    lastError: string | null;
  } | null;
}

interface Step {
  step: string;
  status: number;
  error: string | null;
  /** What a webhook endpoint answered (`data`). */
  reply: Record<string, unknown> | null;
  /** The order an operator route answered with. */
  dto: DtoSummary | null;
  stripe: StripeCall[];
  stripeAccount: StripeAccount;
  /** The stored order is byte-for-byte what it was before the step. */
  untouched: boolean;
  order: OrderState;
}

interface Trail {
  emails: Record<string, number>;
  audit: string[];
  evidence: string[];
}

interface OrderHandle {
  id: string;
  orderNumber: string;
  /** Every session / intent the order has held, in order — <CS_n> / <PI_n>. */
  sessions: string[];
  intents: string[];
}

interface StoredOrder {
  status: string;
  state: string;
  bookingStatus?: string | null;
  pricing: { amount: number; currency: string };
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
      authorizedAt?: Date | null;
      amountAuthorized?: number | null;
      captureExpiresAt?: Date | null;
      capturedAt?: Date | null;
      amountCaptured?: number | null;
      cancelledAt?: Date | null;
      cancelReason?: string | null;
      lastError?: string | null;
    } | null;
  };
}

interface ApiReply {
  ok?: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
}

async function rawOrder(h: OrderHandle): Promise<StoredOrder> {
  const doc = await Order.collection.findOne({ _id: new Types.ObjectId(h.id) });
  expect(doc, `order ${h.id} vanished`).toBeTruthy();
  return doc as unknown as StoredOrder;
}

/** Remember every session / intent the order holds, for the <CS_n>/<PI_n> labels. */
async function learn(h: OrderHandle) {
  const { payment } = await rawOrder(h);
  if (payment.stripeSessionId && !h.sessions.includes(payment.stripeSessionId)) {
    h.sessions.push(payment.stripeSessionId);
  }
  if (payment.paymentIntentId && !h.intents.includes(payment.paymentIntentId)) {
    h.intents.push(payment.paymentIntentId);
  }
}

function stateOf(doc: StoredOrder): OrderState {
  const c = doc.payment.capture ?? null;
  return {
    status: doc.status,
    paymentStatus: doc.payment.status,
    state: doc.state,
    gateway: doc.payment.gateway ?? null,
    session: doc.payment.stripeSessionId ?? null,
    paymentIntent: doc.payment.paymentIntentId ?? null,
    bookingStatus: doc.bookingStatus ?? null,
    capture: c
      ? {
          method: c.method,
          status: c.status,
          amountAuthorized: c.amountAuthorized ?? null,
          amountCaptured: c.amountCaptured ?? null,
          authorized: Boolean(c.authorizedAt),
          captured: Boolean(c.capturedAt),
          cancelled: Boolean(c.cancelledAt),
          holdMs:
            c.authorizedAt && c.captureExpiresAt
              ? new Date(c.captureExpiresAt).getTime() - new Date(c.authorizedAt).getTime()
              : null,
          cancelReason: c.cancelReason ?? null,
          lastError: c.lastError ?? null,
        }
      : null,
    amountReceived: doc.payment.amountReceived ?? null,
    paid: Boolean(doc.payment.paidAt),
  };
}

function dtoOf(order: OrderDTO | null): DtoSummary | null {
  if (!order) return null;
  const c = order.payment.capture;
  return {
    status: order.status,
    paymentStatus: order.payment.status,
    bookingStatus: order.bookingStatus,
    gateway: order.payment.gateway,
    amountReceived: order.payment.amountReceived,
    capture: c
      ? {
          method: c.method,
          status: c.status,
          amountAuthorized: c.amountAuthorized,
          amountCaptured: c.amountCaptured,
          cancelReason: c.cancelReason,
          lastError: c.lastError,
        }
      : null,
  };
}

function orderIn(body: ApiReply): OrderDTO | null {
  const data = body.data;
  if (!body.ok || !data) return null;
  if (data.order) return data.order as OrderDTO;
  // DELETE /api/orders/[id] answers with the order itself.
  return typeof data.id === "string" && data.payment ? (data as unknown as OrderDTO) : null;
}

function replyOf(body: ApiReply): Record<string, unknown> | null {
  return body.ok && body.data && "received" in body.data ? body.data : null;
}

function idempotencyKeyOf(options: unknown): string | null {
  return (options as { idempotencyKey?: string } | undefined)?.idempotencyKey ?? null;
}

function callsOf(entries: TimelineEntry[], intentBefore: string | null): StripeCall[] {
  const calls: StripeCall[] = [];
  for (const entry of entries) {
    if (entry.kind !== "call") continue;
    const [first, second, third] = entry.args;
    switch (entry.method) {
      case "checkout.sessions.create": {
        const params = { ...(first as Record<string, unknown>) };
        if (typeof params.expires_at === "number") params.expires_at = "<EPOCH>";
        calls.push({
          method: entry.method,
          target: null,
          onTheOrdersPaymentIntent: null,
          params,
          idempotencyKey: idempotencyKeyOf(second),
        });
        break;
      }
      case "checkout.sessions.expire":
      case "checkout.sessions.retrieve":
        calls.push({
          method: entry.method,
          target: String(first),
          onTheOrdersPaymentIntent: null,
          params: null,
          idempotencyKey: null,
        });
        break;
      case "paymentIntents.capture":
      case "paymentIntents.cancel":
        calls.push({
          method: entry.method,
          target: String(first),
          onTheOrdersPaymentIntent: first === intentBefore,
          params: second ?? null,
          idempotencyKey: idempotencyKeyOf(third),
        });
        break;
      case "paymentIntents.retrieve":
        calls.push({
          method: entry.method,
          target: String(first),
          onTheOrdersPaymentIntent: first === intentBefore,
          params: null,
          idempotencyKey: null,
        });
        break;
    }
  }
  return calls;
}

function accountOf(entries: TimelineEntry[], lane: Lane): StripeAccount {
  const keys = entries.flatMap((e) => (e.kind === "client" ? [e.secretKey] : []));
  if (keys.length === 0) return "NONE";
  return keys.every((k) => k === lane.stripeSecretKey()) ? "OWN" : "FOREIGN";
}

function label(prefix: "CS" | "PI", known: string[], id: string): string {
  const i = known.indexOf(id);
  return i >= 0 ? `<${prefix}_${i + 1}>` : `<${prefix}_UNKNOWN>`;
}

/** Replace everything that legitimately differs per order and per brand. */
function normalise<T>(value: T, h: OrderHandle, lane: Lane): T {
  let json = JSON.stringify(value)
    .split(h.id)
    .join("<ID>")
    .split(h.orderNumber)
    .join("<ORDER_NUMBER>")
    .split(lane.brandName)
    .join("<BRAND>");
  for (const actor of ACTORS) json = json.split(actor.id).join("<ACTOR_ID>");
  json = json
    .replace(/pi_test_stub_\d+_\d+/g, (id) => label("PI", h.intents, id))
    .replace(/cs_test_stub_\d+_\d+/g, (id) => label("CS", h.sessions, id))
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<UUID>")
    .replace(/\d{4}-\d{2}-\d{2}/g, "<DATE>");
  return JSON.parse(json) as T;
}

/** The PendingEmail rows, audit actions and evidence chain of one order. */
async function trailOf(h: OrderHandle): Promise<Trail> {
  const orderId = new Types.ObjectId(h.id);
  const emails = Object.fromEntries(Object.values(EmailKind).map((k) => [k, 0])) as Record<
    string,
    number
  >;
  for (const row of await PendingEmail.find({ orderId }).lean<{ kind: string }[]>()) {
    emails[row.kind] = (emails[row.kind] ?? 0) + 1;
  }
  const audit = await AuditLog.find({
    $or: [{ entityId: h.id }, { "metadata.orderId": h.id }],
  })
    .sort({ createdAt: 1, _id: 1 })
    .lean<{ action: string }[]>();
  const evidence = await OrderEvidence.find({ orderId })
    .sort({ sequence: 1 })
    .lean<{ eventType: string }[]>();
  return {
    emails,
    audit: audit.map((a) => a.action),
    evidence: evidence.map((e) => e.eventType),
  };
}

/** Every value under a key that names money, anywhere in a gateway request. */
function amountsIn(value: unknown): unknown[] {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, v]) =>
    /amount/i.test(key) ? [v] : amountsIn(v),
  );
}

/* ------------------------------------------------------------------ *
 * The operator, the customer's gateway — real routes
 * ------------------------------------------------------------------ */

/** No session, no organization: a gateway or a signed-out browser. */
function anonymous() {
  sessionMock?.restore();
  sessionMock = null;
  setNextHeaders({});
}

/** `actor` signed in with `orgId` selected; `null` = no session at all (the
 *  REAL session guard then runs and finds no session cookie). */
async function selectAs(actor: AuthenticatedUser | null, orgId: Types.ObjectId) {
  anonymous();
  if (actor) sessionMock = await mockSession(actor);
  setNextHeaders({ cookies: { [orgCookieName()]: String(orgId) } });
}

interface Caller {
  /** Defaults to the ADMIN; null = no session. */
  actor?: AuthenticatedUser | null;
  /** The selected organization; defaults to the lane's own. */
  selected?: Types.ObjectId;
}

const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

/** Run one step and capture everything it did, normalised. */
async function step(
  lane: Lane,
  h: OrderHandle,
  name: string,
  act: () => Promise<Response>,
): Promise<Step> {
  const before = await rawOrder(h);
  const intentBefore = before.payment.paymentIntentId ?? null;
  const mark = timeline.length;
  const res = await act();
  anonymous();
  const { status, body } = await jsonBody<ApiReply>(res);
  const entries = timeline.slice(mark);
  const after = await rawOrder(h);
  await learn(h);
  return normalise<Step>(
    {
      step: name,
      status,
      error: body.ok ? null : (body.error?.message ?? null),
      reply: replyOf(body),
      dto: dtoOf(orderIn(body)),
      stripe: callsOf(entries, intentBefore),
      stripeAccount: accountOf(entries, lane),
      untouched: JSON.stringify(before) === JSON.stringify(after),
      order: stateOf(after),
    },
    h,
    lane,
  );
}

/** The car form, unchanged: a prepaid rental line and a deposit due at the
 *  counter (Budget, Toyota Camry). Posts no `serviceType`. */
function carOrderBody() {
  return validCreateOrderInput({
    charges: [
      { name: "Rental cost", amount: 249.99, timing: PaymentTiming.PREPAID },
      { name: "Deposit", amount: 100, timing: PaymentTiming.DUE_AT_COUNTER },
    ],
  });
}

/** POST /api/orders as the ADMIN with the lane's organization selected. */
async function createCarOrder(lane: Lane): Promise<{ handle: OrderHandle; created: Step }> {
  await selectAs(admin, lane.orgId);
  const mark = timeline.length;
  const res = await createOrderRoute(
    buildRequest("/api/orders", { method: "POST", body: carOrderBody() }),
  );
  anonymous();
  const { status, body } = await jsonBody<ApiReply>(res);
  expect(status, JSON.stringify(body)).toBe(201);
  const dto = orderIn(body)!;
  const handle: OrderHandle = { id: dto.id, orderNumber: dto.orderNumber, sessions: [], intents: [] };
  const entries = timeline.slice(mark);
  const created = normalise<Step>(
    {
      step: "create order",
      status,
      error: null,
      reply: null,
      dto: dtoOf(dto),
      stripe: callsOf(entries, null),
      stripeAccount: accountOf(entries, lane),
      untouched: false,
      order: stateOf(await rawOrder(handle)),
    },
    handle,
    lane,
  );
  return { handle, created };
}

/** POST /api/orders/[id]/generate-payment-link with the composer's body. */
function generateLink(lane: Lane, h: OrderHandle): Promise<Step> {
  return step(lane, h, "generate payment link", async () => {
    await selectAs(admin, lane.orgId);
    return generateLinkRoute(
      buildRequest(`/api/orders/${h.id}/generate-payment-link`, {
        method: "POST",
        body: lane.linkBody,
      }),
      idParams(h.id),
    );
  });
}

/** POST /api/orders/[id]/capture — "Capture payment" / "Retry capture". */
function capture(lane: Lane, h: OrderHandle, name = "capture", as: Caller = {}): Promise<Step> {
  return step(lane, h, name, async () => {
    await selectAs(as.actor === undefined ? admin : as.actor, as.selected ?? lane.orgId);
    return captureRoute(
      buildRequest(`/api/orders/${h.id}/capture`, { method: "POST", body: {} }),
      idParams(h.id),
    );
  });
}

/** POST /api/orders/[id]/cancel-authorization — "Release hold". */
function release(
  lane: Lane,
  h: OrderHandle,
  name = "release",
  reason: string | null = RELEASE_REASON,
  as: Caller = {},
): Promise<Step> {
  return step(lane, h, name, async () => {
    await selectAs(as.actor === undefined ? admin : as.actor, as.selected ?? lane.orgId);
    return cancelAuthorizationRoute(
      buildRequest(`/api/orders/${h.id}/cancel-authorization`, {
        method: "POST",
        body: reason === null ? {} : { reason },
      }),
      idParams(h.id),
    );
  });
}

/** POST /api/orders/[id]/regenerate-link. */
function regenerate(lane: Lane, h: OrderHandle, name = "regenerate link"): Promise<Step> {
  return step(lane, h, name, async () => {
    await selectAs(admin, lane.orgId);
    return regenerateLinkRoute(
      buildRequest(`/api/orders/${h.id}/regenerate-link`, { method: "POST", body: {} }),
      idParams(h.id),
    );
  });
}

/** DELETE /api/orders/[id] — archive. */
function archive(lane: Lane, h: OrderHandle): Promise<Step> {
  return step(lane, h, "archive", async () => {
    await selectAs(admin, lane.orgId);
    return archiveOrderRoute(
      buildRequest(`/api/orders/${h.id}`, {
        method: "DELETE",
        body: { reason: "Customer changed plans" },
      }),
      idParams(h.id),
    );
  });
}

/** A signed Stripe event to the lane's endpoint, as Stripe delivers it. Only
 *  an event the script tells the operator to subscribe the endpoint to can
 *  be relied on to arrive in production. */
function webhook(lane: Lane, h: OrderHandle, name: string, event: Stripe.Event): Promise<Step> {
  expect(
    MANUAL_CAPTURE_STRIPE_EVENTS,
    `${event.type} is not on the subscription list the script prints`,
  ).toContain(event.type);
  return step(lane, h, name, async () => {
    anonymous();
    return lane.deliver(event);
  });
}

/**
 * POST a signed event to `path`, through the route handler Next would
 * dispatch that path to: the deployment endpoint, or the per-organization
 * one with the slug taken from the path. Any other path has no route.
 */
function postStripeWebhook(path: string, event: Stripe.Event, secret: string): Promise<Response> {
  const payload = JSON.stringify(event);
  const request = buildRequest(path, {
    method: "POST",
    body: payload,
    headers: { "stripe-signature": signWebhook(payload, secret) },
  });
  if (path === "/api/webhooks/stripe") return deploymentStripeWebhook(request);
  const orgSlug = /^\/api\/webhooks\/stripe\/([a-z0-9-]+)$/.exec(path)?.[1];
  if (!orgSlug) throw new Error(`No Stripe webhook route serves ${path}`);
  return orgStripeWebhook(request, { params: Promise.resolve({ orgSlug }) });
}

/** The ids an event about the order must carry right now. */
async function idsOf(h: OrderHandle) {
  const doc = await rawOrder(h);
  return {
    sessionId: doc.payment.stripeSessionId!,
    paymentIntentId: doc.payment.paymentIntentId!,
    amountMinor: Math.round(doc.pricing.amount * 100),
  };
}

/** The customer authorizes: checkout.session.completed with payment_status
 *  "unpaid" for the order's CURRENT session and intent. */
async function authorize(
  lane: Lane,
  h: OrderHandle,
  name = "checkout.session.completed (unpaid)",
): Promise<Step> {
  const { sessionId, paymentIntentId, amountMinor } = await idsOf(h);
  const authorized = await webhook(
    lane,
    h,
    name,
    buildCheckoutCompleted({
      orderId: h.id,
      orderNumber: h.orderNumber,
      sessionId,
      paymentIntentId,
      amountTotal: amountMinor,
      customerEmail: CUSTOMER_EMAIL,
      paymentStatus: "unpaid",
    }),
  );
  // From here on Stripe reports the session complete and unpaid: the card is
  // authorized on it, no money has moved.
  stripeNowReports(sessionId, "complete", "unpaid");
  return authorized;
}

async function linkedCarOrder(lane: Lane) {
  const { handle, created } = await createCarOrder(lane);
  const linked = await generateLink(lane, handle);
  expect(linked.status, JSON.stringify(linked)).toBe(200);
  return { handle, created, linked };
}

async function authorizedCarOrder(lane: Lane): Promise<OrderHandle> {
  const { handle } = await linkedCarOrder(lane);
  const authorized = await authorize(lane, handle);
  expect(authorized.status, JSON.stringify(authorized)).toBe(200);
  expect(authorized.order.capture?.status).toBe(PaymentCaptureStatus.AUTHORIZED);
  return handle;
}

/** Raw write, as when the database holds a state no route produces on demand. */
async function setRaw(h: OrderHandle, fields: Record<string, unknown>) {
  await Order.collection.updateOne({ _id: new Types.ObjectId(h.id) }, { $set: fields });
}

/** Run the same scenario on both organizations, reference first. */
async function onBoth<T>(run: (lane: Lane) => Promise<T>): Promise<{ reference: T; rental: T }> {
  const reference = await run(lanes.tripreservations);
  const rental = await run(lanes.rentalconfirmation);
  return { reference, rental };
}

/* ------------------------------------------------------------------ *
 * What the reference must show, absolutely
 * ------------------------------------------------------------------ */

/** The manual-capture Checkout session for the car order: the $249.99
 *  prepaid line alone, the deposit nowhere. */
function manualCarSession() {
  return {
    mode: "payment",
    payment_method_types: ["card"],
    customer_email: CUSTOMER_EMAIL,
    client_reference_id: "<ID>",
    success_url:
      "http://localhost:3000/pay/success?order=<ORDER_NUMBER>&session_id={CHECKOUT_SESSION_ID}",
    cancel_url: "http://localhost:3000/pay/cancelled?order=<ORDER_NUMBER>",
    expires_at: "<EPOCH>",
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: 24999,
          product_data: {
            name: "Budget • Toyota Camry rental",
            description:
              "Pick-up: <DATE> (LAX Airport — Terminal 1) • Drop-off: <DATE> (San Diego Downtown)",
          },
        },
      },
    ],
    metadata: {
      orderId: "<ID>",
      orderNumber: "<ORDER_NUMBER>",
      bookingType: "NEW_BOOKING",
      actorId: "<ACTOR_ID>",
      actorEmail: admin.email,
      appName: "<BRAND>",
    },
    payment_intent_data: {
      description: "<BRAND> • <ORDER_NUMBER>",
      metadata: { orderId: "<ID>", orderNumber: "<ORDER_NUMBER>" },
      capture_method: "manual",
    },
  };
}

/** The same session as a charge-at-checkout link sends it: no capture_method. */
function automaticCarSession() {
  const { payment_intent_data: intentData, ...rest } = manualCarSession();
  return {
    ...rest,
    payment_intent_data: { description: intentData.description, metadata: intentData.metadata },
  };
}

const PENDING_CAPTURE: CaptureState = {
  method: CaptureMode.MANUAL,
  status: PaymentCaptureStatus.PENDING_AUTHORIZATION,
  amountAuthorized: null,
  amountCaptured: null,
  authorized: false,
  captured: false,
  cancelled: false,
  holdMs: null,
  cancelReason: null,
  lastError: null,
};

const AUTHORIZED_CAPTURE: CaptureState = {
  ...PENDING_CAPTURE,
  status: PaymentCaptureStatus.AUTHORIZED,
  amountAuthorized: 249.99,
  authorized: true,
  holdMs: HOLD_MS,
};

/** The car order, authorized on its first session: a hold, not a payment. */
const AUTHORIZED_ORDER: OrderState = {
  status: OrderStatus.LINK_GENERATED,
  paymentStatus: OrderStatus.LINK_GENERATED,
  state: RecordState.ACTIVE,
  gateway: PaymentGatewayKey.STRIPE,
  session: "<CS_1>",
  paymentIntent: "<PI_1>",
  bookingStatus: BookingStatus.PENDING,
  capture: AUTHORIZED_CAPTURE,
  amountReceived: null,
  paid: false,
};

/** …and once captured: paid, the booking confirmed. */
const CAPTURED_ORDER: OrderState = {
  ...AUTHORIZED_ORDER,
  status: OrderStatus.PAID,
  paymentStatus: OrderStatus.PAID,
  bookingStatus: BookingStatus.CONFIRMED,
  capture: {
    ...AUTHORIZED_CAPTURE,
    status: PaymentCaptureStatus.CAPTURED,
    amountCaptured: 249.99,
    captured: true,
  },
  amountReceived: 249.99,
  paid: true,
};

/** …or released by the operator: never charged, the booking cancelled. */
const RELEASED_ORDER: OrderState = {
  ...AUTHORIZED_ORDER,
  bookingStatus: BookingStatus.CANCELLED,
  capture: {
    ...AUTHORIZED_CAPTURE,
    status: PaymentCaptureStatus.CANCELLED,
    cancelled: true,
    cancelReason: RELEASE_REASON,
  },
};

const CAPTURE_CALL: StripeCall = {
  method: "paymentIntents.capture",
  target: "<PI_1>",
  onTheOrdersPaymentIntent: true,
  params: {},
  idempotencyKey: "order:<ID>:capture:<PI_1>",
};

const CANCEL_CALL: StripeCall = {
  method: "paymentIntents.cancel",
  target: "<PI_1>",
  onTheOrdersPaymentIntent: true,
  params: { cancellation_reason: "abandoned" },
  idempotencyKey: "order:<ID>:cancel:<PI_1>",
};

function emails(counts: Partial<Record<EmailKind, number>>): Record<string, number> {
  return {
    [EmailKind.PAYMENT_CONFIRMATION]: 0,
    [EmailKind.PAYMENT_LINK]: 0,
    [EmailKind.PAYMENT_AUTHORIZED]: 0,
    ...counts,
  };
}

/** Audit actions of an order created, linked and authorized. */
const AUTHORIZED_AUDIT = [
  AuditAction.ORDER_CREATED,
  AuditAction.ORDER_PAYMENT_LINK_REGENERATED,
  AuditAction.PAYMENT_AUTHORIZED,
];

/** Evidence chain of an order created, linked and authorized. */
const AUTHORIZED_EVIDENCE = [
  OrderEvidenceEventType.ORDER_CREATED,
  OrderEvidenceEventType.GATEWAY_SELECTED,
  OrderEvidenceEventType.PAYMENT_LINK_GENERATED,
  OrderEvidenceEventType.PAYMENT_AUTHORIZED,
];

/** A refused operator action: nothing written, Stripe never asked. */
function expectRefused(s: Step, status: number, error: string, order: OrderState) {
  expect(s.status, JSON.stringify(s)).toBe(status);
  expect(s.error).toBe(error);
  expect(s.dto).toBeNull();
  expect(s.stripe).toEqual([]);
  expect(s.stripeAccount).toBe("NONE");
  expect(s.untouched).toBe(true);
  expect(s.order).toEqual(order);
}

/* ------------------------------------------------------------------ *
 * The world
 * ------------------------------------------------------------------ */

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  // The deployment Branding singleton — RentalConfirmation's, in production.
  await Branding.findOneAndUpdate(
    { key: BRANDING_KEY },
    {
      $set: {
        key: BRANDING_KEY,
        brandName: RENTAL.brandName,
        supportEmail: RENTAL.supportEmail,
        supportPhone: RENTAL.supportPhone,
        primaryColor: "#0B1220",
      },
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );

  const touched = [
    ...Object.keys(TRIP_STRIPE_ENV),
    ...Object.keys(process.env).filter((k) => k.startsWith(RENTAL_ENV_PREFIX)),
  ];
  envBefore = Object.fromEntries(touched.map((k) => [k, process.env[k]]));
  for (const k of touched) delete process.env[k];
  Object.assign(process.env, TRIP_STRIPE_ENV);

  const tripId = await makeTripReservations();
  const rentalId = await makeRentalConfirmation();
  // The endpoint each Stripe account is configured with, by the script's rule.
  const webhookPathOf = async (id: Types.ObjectId) =>
    stripeWebhookPath((await rawOrg(id)) as { slug: string; isDefault?: boolean });
  const tripPath = await webhookPathOf(tripId);
  const rentalPath = await webhookPathOf(rentalId);
  lanes.tripreservations = {
    key: "tripreservations",
    orgId: tripId,
    brandName: TRIP.brandName,
    linkBody: { gateway: PaymentGatewayKey.STRIPE },
    stripeSecretKey: () => TRIP_STRIPE_SECRET_KEY,
    webhookPath: tripPath,
    deliver: (event) => postStripeWebhook(tripPath, event, TRIP_STRIPE_WEBHOOK_SECRET),
    other: () => lanes.rentalconfirmation,
  };
  lanes.rentalconfirmation = {
    key: "rentalconfirmation",
    orgId: rentalId,
    brandName: RENTAL.brandName,
    linkBody: {},
    stripeSecretKey: () => env.server.STRIPE_SECRET_KEY,
    webhookPath: rentalPath,
    deliver: (event) => postStripeWebhook(rentalPath, event, env.server.STRIPE_WEBHOOK_SECRET),
    other: () => lanes.tripreservations,
  };

  await recordStripe();
});

afterEach(() => {
  anonymous();
  for (const [k, v] of Object.entries(envBefore)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  envBefore = {};
  nextCancelRefusal = null;
});

/* ================================================================== *
 * FIXTURES
 * ================================================================== */

describe("fixtures — the two organizations are what the matrix claims", () => {
  it("the reference is TripReservations-shaped on MANUAL with its OWN Stripe account; Rental is the default organization as production stores it, on the DEPLOYMENT account, with no credentials of its own", async () => {
    const trip = await rawOrg(lanes.tripreservations.orgId);
    expect(trip).toMatchObject({
      slug: TRIP.slug,
      brandName: TRIP.brandName,
      isDefault: false,
      payments: {
        provider: PaymentGatewayKey.PAYPAL,
        enabledProviders: [PaymentGatewayKey.PAYPAL, PaymentGatewayKey.STRIPE],
        captureMode: CaptureMode.MANUAL,
      },
      serviceTypes: [ServiceType.CAR_RENTAL, ServiceType.FLIGHT],
    });
    expect("legal" in trip).toBe(false);

    const rental = await rawOrg(lanes.rentalconfirmation.orgId);
    expect(rental).toMatchObject({
      slug: RENTAL.slug,
      brandName: RENTAL.brandName,
      isDefault: true,
      payments: {
        provider: PaymentGatewayKey.STRIPE,
        enabledProviders: [PaymentGatewayKey.STRIPE],
      },
    });
    expect("serviceTypes" in rental).toBe(false);
    expect("legal" in rental).toBe(false);
    // No capture mode stored at all — production's default organization
    // predates the field and reads AUTOMATIC through `?? AUTOMATIC`.
    expect("captureMode" in (rental.payments as Record<string, unknown>)).toBe(false);

    // The endpoints the script tells each Stripe account to call — and the
    // ones this file delivers to: Rental keeps the DEPLOYMENT endpoint, the
    // reference has its own.
    expect(lanes.rentalconfirmation.webhookPath).toBe("/api/webhooks/stripe");
    expect(lanes.tripreservations.webhookPath).toBe(`/api/webhooks/stripe/${TRIP.slug}`);

    // Rental has no account of its own anywhere: no env, no vault.
    expect(Object.keys(process.env).filter((k) => k.startsWith(RENTAL_ENV_PREFIX))).toEqual([]);
    expect(
      await OrganizationCredential.countDocuments({ organizationId: lanes.rentalconfirmation.orgId }),
    ).toBe(0);
    expect(await getGatewayForOrganization(String(lanes.rentalconfirmation.orgId))).toBe(
      getDefaultGateway(),
    );
    // The reference's Stripe is its own gateway, never the deployment's.
    const tripStripe = await getGatewayForOrganization(
      String(lanes.tripreservations.orgId),
      PaymentGatewayKey.STRIPE,
    );
    expect(tripStripe.key).toBe(PaymentGatewayKey.STRIPE);
    expect(tripStripe).not.toBe(getDefaultGateway());
    // Two different merchant accounts (compared, never printed).
    expect(TRIP_STRIPE_SECRET_KEY === env.server.STRIPE_SECRET_KEY).toBe(false);
    expect(TRIP_STRIPE_WEBHOOK_SECRET === env.server.STRIPE_WEBHOOK_SECRET).toBe(false);

    expect(await getOrganizationCaptureMode(String(lanes.tripreservations.orgId))).toBe(
      CaptureMode.MANUAL,
    );
    // Before the switch, Rental — and every order stored without an
    // organization, which is Rental's — charges at checkout.
    expect(await getOrganizationCaptureMode(String(lanes.rentalconfirmation.orgId))).toBe(
      CaptureMode.AUTOMATIC,
    );
    expect(await getOrganizationCaptureMode(null)).toBe(CaptureMode.AUTOMATIC);
  }, 60_000);

  it("the switch is ONE narrow write, read on every NEW link: before it Rental's link charges at checkout; after it the next link authorizes; the link generated before stays exactly as it was", async () => {
    const lane = lanes.rentalconfirmation;
    const before = await linkedCarOrder(lane);
    expect(before.linked.stripe).toEqual([
      {
        method: "checkout.sessions.create",
        target: null,
        onTheOrdersPaymentIntent: null,
        params: automaticCarSession(),
        idempotencyKey: "order:<ID>:checkout",
      },
    ]);
    expect(before.linked.stripeAccount).toBe("OWN");
    expect(before.linked.order.capture).toBeNull();
    expect(before.linked.order.bookingStatus).toBeNull();
    const firstOrderAsLinked = await rawOrder(before.handle);

    const orgBefore = await rawOrg(lane.orgId);
    expect("captureMode" in (orgBefore.payments as Record<string, unknown>)).toBe(false);
    await switchRentalToManual();
    const orgAfter = await rawOrg(lane.orgId);
    // Exactly one key moved: payments.captureMode appeared, as MANUAL.
    const { captureMode: written, ...paymentsWithoutMode } = orgAfter.payments as Record<
      string,
      unknown
    >;
    expect(written).toBe(CaptureMode.MANUAL);
    expect({ ...orgAfter, payments: paymentsWithoutMode }).toEqual(orgBefore);

    expect(await getOrganizationCaptureMode(String(lane.orgId))).toBe(CaptureMode.MANUAL);
    // NEW: an order stored without an organization belongs to the default
    // organization, so it takes Rental's decision too.
    expect(await getOrganizationCaptureMode(null)).toBe(CaptureMode.MANUAL);
    expect(await getOrganizationCaptureMode("")).toBe(CaptureMode.MANUAL);
    expect(await getOrganizationCaptureMode("not-an-object-id")).toBe(CaptureMode.AUTOMATIC);
    // The reference's own decision is untouched by Rental's.
    expect(await getOrganizationCaptureMode(String(lanes.tripreservations.orgId))).toBe(
      CaptureMode.MANUAL,
    );

    const after = await linkedCarOrder(lane);
    expect(after.linked.stripe).toEqual([
      {
        method: "checkout.sessions.create",
        target: null,
        onTheOrdersPaymentIntent: null,
        params: manualCarSession(),
        idempotencyKey: "order:<ID>:checkout:manual",
      },
    ]);
    expect(after.linked.order.capture).toEqual(PENDING_CAPTURE);
    expect(after.linked.order.bookingStatus).toBe(BookingStatus.PENDING);
    // The link generated before the switch is not touched…
    expect(await rawOrder(before.handle)).toEqual(firstOrderAsLinked);
    // …and stays out of reach of Capture and Release: it charges at
    // checkout, whatever Rental runs now. Stripe is never asked.
    expectRefused(
      await capture(lane, before.handle, "capture the order linked before the switch"),
      409,
      MSG.chargedAtCheckout,
      before.linked.order,
    );
    expectRefused(
      await release(lane, before.handle, "release the order linked before the switch"),
      409,
      MSG.chargedAtCheckout,
      before.linked.order,
    );
    expect(await rawOrder(before.handle)).toEqual(firstOrderAsLinked);
  }, 60_000);

  it("an order stored without an organization reads AUTOMATIC when the default organization stores no mode, or stores AUTOMATIC, and when there is no default organization at all", async () => {
    const rentalId = lanes.rentalconfirmation.orgId;
    // The default organization as production has it: written before the
    // field existed, no key.
    expect("captureMode" in ((await rawOrg(rentalId)).payments as Record<string, unknown>)).toBe(
      false,
    );
    expect(await getOrganizationCaptureMode(null)).toBe(CaptureMode.AUTOMATIC);
    expect(await getOrganizationCaptureMode("")).toBe(CaptureMode.AUTOMATIC);
    expect(await getOrganizationCaptureMode(String(rentalId))).toBe(CaptureMode.AUTOMATIC);

    // AUTOMATIC stored explicitly reads the same.
    await Organization.collection.updateOne(
      { _id: rentalId },
      { $set: { "payments.captureMode": CaptureMode.AUTOMATIC } },
    );
    expect(await getOrganizationCaptureMode(null)).toBe(CaptureMode.AUTOMATIC);

    // MANUAL stored, but no organization is the default any more: nothing
    // owns an unattributed order, so nothing opts it in.
    await Organization.collection.updateOne(
      { _id: rentalId },
      { $set: { "payments.captureMode": CaptureMode.MANUAL, isDefault: false } },
    );
    expect(await Organization.countDocuments({ isDefault: true })).toBe(0);
    expect(await getOrganizationCaptureMode(null)).toBe(CaptureMode.AUTOMATIC);
    expect(await getOrganizationCaptureMode(String(rentalId))).toBe(CaptureMode.MANUAL);
  }, 60_000);
});

/* ================================================================== *
 * THE PARITY MATRIX — Rental switched to MANUAL
 * ================================================================== */

describe("the parity matrix — Rental on MANUAL runs exactly the reference's lifecycle", () => {
  beforeEach(switchRentalToManual);

  describe("S1–S2 · the link and the authorization", () => {
    async function s1(lane: Lane) {
      const { handle, created, linked } = await linkedCarOrder(lane);
      return { steps: [created, linked], trail: await trailOf(handle) };
    }

    it("S1 link: a manual-capture Checkout session (capture_method 'manual', key order:<ID>:checkout:manual) for the $249.99 prepaid line ONLY, on the organization's own account; the order PENDING_AUTHORIZATION, booking PENDING, LINK_GENERATED", async () => {
      const { reference, rental } = await onBoth(s1);
      expect(rental).toEqual(reference);

      const [created, linked] = reference.steps;
      expect(created).toMatchObject({ status: 201, error: null, stripe: [], stripeAccount: "NONE" });
      expect(created.order).toMatchObject({
        status: OrderStatus.NOT_INITIATED,
        capture: null,
        bookingStatus: null,
        session: null,
        paymentIntent: null,
      });
      expect(linked.status).toBe(200);
      expect(linked.stripe).toEqual([
        {
          method: "checkout.sessions.create",
          target: null,
          onTheOrdersPaymentIntent: null,
          params: manualCarSession(),
          idempotencyKey: "order:<ID>:checkout:manual",
        },
      ]);
      // The deposit is never charged: 24999 is the only money in the request.
      expect(amountsIn(linked.stripe[0]!.params)).toEqual([24999]);
      expect(JSON.stringify(linked.stripe[0]!.params)).not.toMatch(/10000|34999|100\.00|349\.99/);
      expect(linked.stripeAccount).toBe("OWN");
      expect(linked.order).toEqual({
        ...AUTHORIZED_ORDER,
        capture: PENDING_CAPTURE,
      });
      expect(linked.dto).toEqual({
        status: OrderStatus.LINK_GENERATED,
        paymentStatus: OrderStatus.LINK_GENERATED,
        bookingStatus: BookingStatus.PENDING,
        gateway: PaymentGatewayKey.STRIPE,
        amountReceived: null,
        capture: {
          method: CaptureMode.MANUAL,
          status: PaymentCaptureStatus.PENDING_AUTHORIZATION,
          amountAuthorized: null,
          amountCaptured: null,
          cancelReason: null,
          lastError: null,
        },
      });
      expect(reference.trail).toEqual({
        emails: emails({}),
        audit: [AuditAction.ORDER_CREATED, AuditAction.ORDER_PAYMENT_LINK_REGENERATED],
        evidence: [
          OrderEvidenceEventType.ORDER_CREATED,
          OrderEvidenceEventType.GATEWAY_SELECTED,
          OrderEvidenceEventType.PAYMENT_LINK_GENERATED,
        ],
      });
    }, 60_000);

    async function s2(lane: Lane) {
      const { handle } = await linkedCarOrder(lane);
      const completed = await authorize(lane, handle);
      const emailsAfterCompletion = (await trailOf(handle)).emails;
      const { paymentIntentId, amountMinor } = await idsOf(handle);
      const capturable = await webhook(
        lane,
        handle,
        "payment_intent.amount_capturable_updated (same intent)",
        buildAmountCapturableUpdated({
          paymentIntentId,
          orderId: handle.id,
          orderNumber: handle.orderNumber,
          amountCapturable: amountMinor,
        }),
      );
      return { steps: [completed, capturable], emailsAfterCompletion, trail: await trailOf(handle) };
    }

    it("S2 authorize: an unpaid checkout.session.completed makes it AUTHORIZED ($249.99 held for exactly 7 days, still LINK_GENERATED) with ONE 'card authorized' email and no receipt; payment_intent.amount_capturable_updated for the same intent is a duplicate", async () => {
      const { reference, rental } = await onBoth(s2);
      expect(rental).toEqual(reference);

      const [completed, capturable] = reference.steps;
      expect(completed).toMatchObject({ status: 200, error: null, stripe: [] });
      expect(completed.reply).toEqual({
        received: true,
        handled: true,
        duplicate: false,
        orderId: "<ID>",
      });
      // The signature was verified on the organization's own account.
      expect(completed.stripeAccount).toBe("OWN");
      expect(completed.untouched).toBe(false);
      expect(completed.order).toEqual(AUTHORIZED_ORDER);
      expect(completed.order.capture?.holdMs).toBe(HOLD_MS);
      expect(reference.emailsAfterCompletion).toEqual(
        emails({ [EmailKind.PAYMENT_AUTHORIZED]: 1 }),
      );

      expect(capturable.status).toBe(200);
      expect(capturable.reply).toEqual({
        received: true,
        handled: true,
        duplicate: true,
        orderId: "<ID>",
      });
      expect(capturable.untouched).toBe(true);
      expect(capturable.order).toEqual(AUTHORIZED_ORDER);
      expect(reference.trail).toEqual({
        emails: emails({ [EmailKind.PAYMENT_AUTHORIZED]: 1 }),
        audit: [...AUTHORIZED_AUDIT, AuditAction.WEBHOOK_DUPLICATE],
        evidence: [
          OrderEvidenceEventType.ORDER_CREATED,
          OrderEvidenceEventType.GATEWAY_SELECTED,
          OrderEvidenceEventType.PAYMENT_LINK_GENERATED,
          OrderEvidenceEventType.PAYMENT_AUTHORIZED,
        ],
      });
    }, 60_000);
  });

  describe("S3–S5 · capture", () => {
    async function s3(lane: Lane) {
      const handle = await authorizedCarOrder(lane);
      const captured = await capture(lane, handle);
      return { steps: [captured], trail: await trailOf(handle) };
    }

    it("S3 capture (ADMIN): 200 and exactly ONE paymentIntents.capture on the order's intent (params {}, key order:<ID>:capture:<PI>) — PAID, CAPTURED, booking CONFIRMED, $249.99 captured and received, ONE receipt, audit PAYMENT_CAPTURED", async () => {
      const { reference, rental } = await onBoth(s3);
      expect(rental).toEqual(reference);

      const [captured] = reference.steps;
      expect(captured.status).toBe(200);
      expect(captured.error).toBeNull();
      expect(captured.stripe).toEqual([CAPTURE_CALL]);
      expect(captured.stripeAccount).toBe("OWN");
      expect(captured.order).toEqual(CAPTURED_ORDER);
      expect(captured.dto).toEqual({
        status: OrderStatus.PAID,
        paymentStatus: OrderStatus.PAID,
        bookingStatus: BookingStatus.CONFIRMED,
        gateway: PaymentGatewayKey.STRIPE,
        amountReceived: 249.99,
        capture: {
          method: CaptureMode.MANUAL,
          status: PaymentCaptureStatus.CAPTURED,
          amountAuthorized: 249.99,
          amountCaptured: 249.99,
          cancelReason: null,
          lastError: null,
        },
      });
      expect(reference.trail.emails).toEqual(
        emails({ [EmailKind.PAYMENT_AUTHORIZED]: 1, [EmailKind.PAYMENT_CONFIRMATION]: 1 }),
      );
      expect(reference.trail.audit).toEqual([
        ...AUTHORIZED_AUDIT,
        AuditAction.PAYMENT_SUCCEEDED,
        AuditAction.PAYMENT_CAPTURED,
      ]);
      // The money settled once, then the operator's capture is on record.
      expect(reference.trail.evidence).toEqual([
        ...AUTHORIZED_EVIDENCE,
        OrderEvidenceEventType.PAYMENT_COMPLETED,
        OrderEvidenceEventType.PAYMENT_CAPTURED,
      ]);
    }, 60_000);

    async function s4(lane: Lane) {
      const handle = await authorizedCarOrder(lane);
      const first = await capture(lane, handle);
      const trailAfterFirst = await trailOf(handle);
      const again = await capture(lane, handle, "capture again");
      return { steps: [first, again], trailAfterFirst, trail: await trailOf(handle) };
    }

    it("S4 capture again: 200, no second Stripe call, nothing written, nothing new enqueued or audited", async () => {
      const { reference, rental } = await onBoth(s4);
      expect(rental).toEqual(reference);

      const [first, again] = reference.steps;
      expect(first.stripe).toEqual([CAPTURE_CALL]);
      expect(again.status).toBe(200);
      expect(again.error).toBeNull();
      expect(again.stripe).toEqual([]);
      expect(again.stripeAccount).toBe("NONE");
      expect(again.untouched).toBe(true);
      expect(again.order).toEqual(CAPTURED_ORDER);
      expect(again.dto?.capture?.status).toBe(PaymentCaptureStatus.CAPTURED);
      expect(reference.trail).toEqual(reference.trailAfterFirst);
      expect(reference.trail.emails[EmailKind.PAYMENT_CONFIRMATION]).toBe(1);
    }, 60_000);

    async function s5(lane: Lane) {
      const handle = await authorizedCarOrder(lane);
      const captured = await capture(lane, handle);
      const { paymentIntentId, amountMinor } = await idsOf(handle);
      const late = await webhook(
        lane,
        handle,
        "payment_intent.succeeded (manual) after the capture",
        buildPaymentIntentSucceeded({
          paymentIntentId,
          orderId: handle.id,
          orderNumber: handle.orderNumber,
          amountReceived: amountMinor,
        }),
      );
      return { steps: [captured, late], trail: await trailOf(handle) };
    }

    it("S5 the payment_intent.succeeded Stripe sends after the operator's capture is a duplicate: the order is not written again and there is still ONE receipt", async () => {
      const { reference, rental } = await onBoth(s5);
      expect(rental).toEqual(reference);

      const [, late] = reference.steps;
      expect(late.status).toBe(200);
      expect(late.reply).toEqual({
        received: true,
        handled: true,
        duplicate: true,
        orderId: "<ID>",
      });
      expect(late.stripeAccount).toBe("OWN");
      expect(late.untouched).toBe(true);
      expect(late.order).toEqual(CAPTURED_ORDER);
      expect(reference.trail.emails).toEqual(
        emails({ [EmailKind.PAYMENT_AUTHORIZED]: 1, [EmailKind.PAYMENT_CONFIRMATION]: 1 }),
      );
      expect(reference.trail.audit).toEqual([
        ...AUTHORIZED_AUDIT,
        AuditAction.PAYMENT_SUCCEEDED,
        AuditAction.PAYMENT_CAPTURED,
        AuditAction.WEBHOOK_DUPLICATE,
      ]);
      // The money settled once.
      expect(
        reference.trail.evidence.filter((e) => e === OrderEvidenceEventType.PAYMENT_COMPLETED),
      ).toHaveLength(1);
    }, 60_000);
  });

  describe("S6–S8 · release (the client's 'Uncapture')", () => {
    async function s6(lane: Lane) {
      const handle = await authorizedCarOrder(lane);
      const emailsBefore = (await trailOf(handle)).emails;
      const released = await release(lane, handle);
      return { steps: [released], emailsBefore, trail: await trailOf(handle) };
    }

    it("S6 release (ADMIN, 'Supplier could not confirm'): 200 and exactly ONE paymentIntents.cancel (cancellation_reason 'abandoned', key order:<ID>:cancel:<PI>) — CANCELLED, booking CANCELLED, the typed reason kept, still LINK_GENERATED, no email", async () => {
      const { reference, rental } = await onBoth(s6);
      expect(rental).toEqual(reference);

      const [released] = reference.steps;
      expect(released.status).toBe(200);
      expect(released.error).toBeNull();
      expect(released.stripe).toEqual([CANCEL_CALL]);
      expect(released.stripeAccount).toBe("OWN");
      expect(released.order).toEqual(RELEASED_ORDER);
      expect(released.dto).toEqual({
        status: OrderStatus.LINK_GENERATED,
        paymentStatus: OrderStatus.LINK_GENERATED,
        bookingStatus: BookingStatus.CANCELLED,
        gateway: PaymentGatewayKey.STRIPE,
        amountReceived: null,
        capture: {
          method: CaptureMode.MANUAL,
          status: PaymentCaptureStatus.CANCELLED,
          amountAuthorized: 249.99,
          amountCaptured: null,
          cancelReason: RELEASE_REASON,
          lastError: null,
        },
      });
      // Nothing enqueued by the release: the customer was never charged.
      expect(reference.trail.emails).toEqual(reference.emailsBefore);
      expect(reference.trail.emails).toEqual(emails({ [EmailKind.PAYMENT_AUTHORIZED]: 1 }));
      expect(reference.trail.audit).toEqual([
        ...AUTHORIZED_AUDIT,
        AuditAction.AUTHORIZATION_RELEASED,
      ]);
      expect(reference.trail.evidence).toEqual([
        ...AUTHORIZED_EVIDENCE,
        OrderEvidenceEventType.AUTHORIZATION_RELEASED,
      ]);
    }, 60_000);

    async function s7(lane: Lane) {
      const handle = await authorizedCarOrder(lane);
      const first = await release(lane, handle);
      const again = await release(lane, handle, "release again");
      return { steps: [first, again], trail: await trailOf(handle) };
    }

    it("S7 release again: 200 no-op — no second cancel, nothing written", async () => {
      const { reference, rental } = await onBoth(s7);
      expect(rental).toEqual(reference);

      const [first, again] = reference.steps;
      expect(first.stripe).toEqual([CANCEL_CALL]);
      expect(again.status).toBe(200);
      expect(again.error).toBeNull();
      expect(again.stripe).toEqual([]);
      expect(again.stripeAccount).toBe("NONE");
      expect(again.untouched).toBe(true);
      expect(again.order).toEqual(RELEASED_ORDER);
      // The operator is shown the released hold, their reason intact.
      expect(again.dto?.capture).toMatchObject({
        status: PaymentCaptureStatus.CANCELLED,
        cancelReason: RELEASE_REASON,
      });
      expect(
        reference.trail.audit.filter((a) => a === AuditAction.AUTHORIZATION_RELEASED),
      ).toHaveLength(1);
    }, 60_000);

    async function s8(lane: Lane) {
      const handle = await authorizedCarOrder(lane);
      const released = await release(lane, handle);
      const { paymentIntentId } = await idsOf(handle);
      const late = await webhook(
        lane,
        handle,
        "payment_intent.canceled (abandoned) after the release",
        buildPaymentIntentCanceled({
          paymentIntentId,
          orderId: handle.id,
          orderNumber: handle.orderNumber,
          cancellationReason: "abandoned",
        }),
      );
      return { steps: [released, late], trail: await trailOf(handle) };
    }

    it("S8 the payment_intent.canceled ('abandoned') Stripe sends after the release is a no-op: still CANCELLED with the operator's reason", async () => {
      const { reference, rental } = await onBoth(s8);
      expect(rental).toEqual(reference);

      const [released, late] = reference.steps;
      expect(released.stripe).toEqual([CANCEL_CALL]);
      expect(late.status).toBe(200);
      expect(late.reply).toEqual({
        received: true,
        handled: true,
        duplicate: true,
        orderId: "<ID>",
      });
      expect(late.stripe).toEqual([]);
      expect(late.stripeAccount).toBe("OWN");
      expect(late.untouched).toBe(true);
      expect(late.order).toEqual(RELEASED_ORDER);
      // The operator's release is the only one on record — the gateway's
      // echo added no audit row, no evidence entry and no email.
      expect(reference.trail).toEqual({
        emails: emails({ [EmailKind.PAYMENT_AUTHORIZED]: 1 }),
        audit: [...AUTHORIZED_AUDIT, AuditAction.AUTHORIZATION_RELEASED],
        evidence: [...AUTHORIZED_EVIDENCE, OrderEvidenceEventType.AUTHORIZATION_RELEASED],
      });
    }, 60_000);
  });

  describe("S9–S11 · stale and concurrent actions", () => {
    async function s9(lane: Lane) {
      const released = await authorizedCarOrder(lane);
      const releasedSteps = [
        await release(lane, released),
        await capture(lane, released, "capture after release"),
      ];
      const releasedOutcome = { steps: releasedSteps, trail: await trailOf(released) };

      const captured = await authorizedCarOrder(lane);
      const capturedSteps = [
        await capture(lane, captured),
        await release(lane, captured, "release after capture"),
      ];
      const capturedOutcome = { steps: capturedSteps, trail: await trailOf(captured) };
      return { releasedThenCaptured: releasedOutcome, capturedThenReleased: capturedOutcome };
    }

    it("S9 stale: capture after release → 409 'Cannot capture — the payment is cancelled.'; release after capture → 409 'This payment has already been captured…'; Stripe is never asked", async () => {
      const { reference, rental } = await onBoth(s9);
      expect(rental).toEqual(reference);

      const [released, staleCapture] = reference.releasedThenCaptured.steps;
      expect(released.stripe).toEqual([CANCEL_CALL]);
      expectRefused(staleCapture, 409, MSG.cannotCapture("cancelled"), RELEASED_ORDER);

      const [captured, staleRelease] = reference.capturedThenReleased.steps;
      expect(captured.stripe).toEqual([CAPTURE_CALL]);
      expectRefused(staleRelease, 409, MSG.capturedAlready, CAPTURED_ORDER);
      expect(reference.capturedThenReleased.trail.audit).not.toContain(
        AuditAction.AUTHORIZATION_RELEASED,
      );
      expect(reference.releasedThenCaptured.trail.audit).not.toContain(
        AuditAction.PAYMENT_CAPTURED,
      );
    }, 60_000);

    async function s10(lane: Lane) {
      const handle = await authorizedCarOrder(lane);
      await setRaw(handle, { "payment.capture.status": PaymentCaptureStatus.CAPTURE_PENDING });
      const steps = [await capture(lane, handle), await release(lane, handle)];
      return { steps, trail: await trailOf(handle) };
    }

    it("S10 while a capture is in flight (CAPTURE_PENDING, set raw): capture → 409 'Cannot capture — the payment is capture_pending.'; release → 409 'Cannot release — the payment is capture_pending.'", async () => {
      const { reference, rental } = await onBoth(s10);
      expect(rental).toEqual(reference);

      const inFlight: OrderState = {
        ...AUTHORIZED_ORDER,
        capture: { ...AUTHORIZED_CAPTURE, status: PaymentCaptureStatus.CAPTURE_PENDING },
      };
      const [captureStep, releaseStep] = reference.steps;
      expectRefused(captureStep, 409, MSG.cannotCapture("capture_pending"), inFlight);
      expectRefused(releaseStep, 409, MSG.cannotRelease("capture_pending"), inFlight);
    }, 60_000);

    /** Two "Capture payment" requests at once (a double-click on two tabs). */
    async function s11(lane: Lane) {
      const handle = await authorizedCarOrder(lane);
      const intentBefore = (await rawOrder(handle)).payment.paymentIntentId ?? null;
      await selectAs(admin, lane.orgId);
      const mark = timeline.length;
      const responses = await Promise.all(
        [0, 1].map(() =>
          captureRoute(
            buildRequest(`/api/orders/${handle.id}/capture`, { method: "POST", body: {} }),
            idParams(handle.id),
          ),
        ),
      );
      anonymous();
      const replies = await Promise.all(responses.map((r) => jsonBody<ApiReply>(r)));
      const entries = timeline.slice(mark);
      const answers = replies.map(({ status, body }) => ({
        status,
        error: body.ok ? null : (body.error?.message ?? null),
      }));
      await learn(handle);
      return {
        // Compared between the organizations: what the race left behind.
        comparable: normalise(
          {
            stripe: callsOf(entries, intentBefore),
            stripeAccount: accountOf(entries, lane),
            order: stateOf(await rawOrder(handle)),
            trail: await trailOf(handle),
          },
          handle,
          lane,
        ),
        // Not compared: which request wins the claim varies run to run.
        answers,
      };
    }

    it("S11 two captures in parallel: exactly ONE Stripe capture, the order CAPTURED/PAID with ONE receipt; the other request is 200 or a known 409", async () => {
      const { reference, rental } = await onBoth(s11);
      expect(rental.comparable).toEqual(reference.comparable);

      // The same invariants, on each organization's own answers.
      for (const { answers } of [reference, rental]) {
        const seen = JSON.stringify(answers);
        expect(answers, seen).toHaveLength(2);
        expect(answers.some((a) => a.status === 200), seen).toBe(true);
        for (const answer of answers) {
          if (answer.status === 200) expect(answer.error, seen).toBeNull();
          else {
            expect(answer.status, seen).toBe(409);
            expect(CONCURRENT_REFUSALS, seen).toContain(answer.error);
          }
        }
      }

      const outcome = reference.comparable;
      expect(outcome.stripe).toEqual([CAPTURE_CALL]);
      expect(outcome.stripeAccount).toBe("OWN");
      expect(outcome.order).toEqual(CAPTURED_ORDER);
      expect(outcome.trail.emails).toEqual(
        emails({ [EmailKind.PAYMENT_AUTHORIZED]: 1, [EmailKind.PAYMENT_CONFIRMATION]: 1 }),
      );
      expect(outcome.trail.audit).toEqual([
        ...AUTHORIZED_AUDIT,
        AuditAction.PAYMENT_SUCCEEDED,
        AuditAction.PAYMENT_CAPTURED,
      ]);
    }, 60_000);
  });

  describe("S12–S16 · the gateway says no, or the hold lapses", () => {
    async function s12(lane: Lane) {
      const handle = await authorizedCarOrder(lane);
      getCurrentTestStripe().failNextCapture(STRIPE_CAPTURE_REFUSAL);
      const refused = await capture(lane, handle);
      const trailAfterRefusal = await trailOf(handle);
      const retried = await capture(lane, handle, "retry capture");
      return { steps: [refused, retried], trailAfterRefusal, trail: await trailOf(handle) };
    }

    it("S12 Stripe refuses the capture (payment_intent_unexpected_state): 502 'Could not capture this payment', CAPTURE_FAILED with Stripe's message, audit PAYMENT_CAPTURE_FAILED, NOT paid; then 'Retry capture' takes the money", async () => {
      const { reference, rental } = await onBoth(s12);
      expect(rental).toEqual(reference);

      const [refused, retried] = reference.steps;
      expect(refused.status).toBe(502);
      expect(refused.error).toBe(MSG.captureFailed);
      expect(refused.dto).toBeNull();
      // The attempt reached Stripe, with the per-order key.
      expect(refused.stripe).toEqual([CAPTURE_CALL]);
      expect(refused.stripeAccount).toBe("OWN");
      expect(refused.order).toEqual({
        ...AUTHORIZED_ORDER,
        capture: {
          ...AUTHORIZED_CAPTURE,
          status: PaymentCaptureStatus.CAPTURE_FAILED,
          lastError: STRIPE_CAPTURE_REFUSAL.message,
        },
      });
      expect(reference.trailAfterRefusal.audit).toEqual([
        ...AUTHORIZED_AUDIT,
        AuditAction.PAYMENT_CAPTURE_FAILED,
      ]);
      expect(reference.trailAfterRefusal.emails[EmailKind.PAYMENT_CONFIRMATION]).toBe(0);

      expect(retried.status).toBe(200);
      // The retry captures the same hold. Its key is compared between the
      // two organizations above; absolutely, only that it is this order's
      // capture key is pinned — not that it repeats the refused attempt's
      // key verbatim, which Stripe would answer by replaying the refusal
      // (the stub does not model idempotent replay).
      expect(retried.stripe).toHaveLength(1);
      expect(retried.stripe[0]).toMatchObject({
        method: "paymentIntents.capture",
        target: "<PI_1>",
        onTheOrdersPaymentIntent: true,
        params: {},
      });
      expect(retried.stripe[0]!.idempotencyKey).toMatch(/^order:<ID>:capture(:|$)/);
      expect(retried.stripeAccount).toBe("OWN");
      expect(retried.order).toEqual(CAPTURED_ORDER);
      expect(reference.trail.emails[EmailKind.PAYMENT_CONFIRMATION]).toBe(1);
      expect(reference.trail.audit).toEqual([
        ...AUTHORIZED_AUDIT,
        AuditAction.PAYMENT_CAPTURE_FAILED,
        AuditAction.PAYMENT_SUCCEEDED,
        AuditAction.PAYMENT_CAPTURED,
      ]);
    }, 60_000);

    async function s13(lane: Lane) {
      const handle = await authorizedCarOrder(lane);
      nextCancelRefusal = STRIPE_CANCEL_REFUSAL;
      const refused = await release(lane, handle);
      return { steps: [refused], trail: await trailOf(handle) };
    }

    it("S13 Stripe refuses the release: 502 'Could not release this authorization', the order unchanged (AUTHORIZED), no AUTHORIZATION_RELEASED", async () => {
      const { reference, rental } = await onBoth(s13);
      expect(rental).toEqual(reference);

      const [refused] = reference.steps;
      expect(refused.status).toBe(502);
      expect(refused.error).toBe(MSG.releaseFailed);
      expect(refused.dto).toBeNull();
      // The attempt reached Stripe, which said no.
      expect(refused.stripe).toEqual([CANCEL_CALL]);
      expect(refused.stripeAccount).toBe("OWN");
      expect(refused.untouched).toBe(true);
      expect(refused.order).toEqual(AUTHORIZED_ORDER);
      expect(reference.trail.audit).toEqual(AUTHORIZED_AUDIT);
      expect(reference.trail.audit).not.toContain(AuditAction.AUTHORIZATION_RELEASED);
      expect(reference.trail.emails).toEqual(emails({ [EmailKind.PAYMENT_AUTHORIZED]: 1 }));
    }, 60_000);

    async function s14(lane: Lane) {
      const handle = await authorizedCarOrder(lane);
      const { paymentIntentId } = await idsOf(handle);
      const lapsed = await webhook(
        lane,
        handle,
        "payment_intent.canceled (automatic)",
        buildPaymentIntentCanceled({
          paymentIntentId,
          orderId: handle.id,
          orderNumber: handle.orderNumber,
          cancellationReason: "automatic",
        }),
      );
      const steps = [lapsed, await capture(lane, handle), await release(lane, handle)];
      return { steps, trail: await trailOf(handle) };
    }

    it("S14 the hold expires (payment_intent.canceled, 'automatic'): AUTHORIZATION_EXPIRED, booking CANCELLED; then capture → 409 '…authorization_expired.' and release → 200 no-op", async () => {
      const { reference, rental } = await onBoth(s14);
      expect(rental).toEqual(reference);

      const expiredOrder: OrderState = {
        ...AUTHORIZED_ORDER,
        bookingStatus: BookingStatus.CANCELLED,
        capture: {
          ...AUTHORIZED_CAPTURE,
          status: PaymentCaptureStatus.AUTHORIZATION_EXPIRED,
          cancelled: true,
          cancelReason: "automatic",
        },
      };
      const [lapsed, captureStep, releaseStep] = reference.steps;
      expect(lapsed.status).toBe(200);
      expect(lapsed.reply).toEqual({
        received: true,
        handled: true,
        duplicate: false,
        orderId: "<ID>",
      });
      expect(lapsed.stripeAccount).toBe("OWN");
      expect(lapsed.order).toEqual(expiredOrder);
      expectRefused(captureStep, 409, MSG.cannotCapture("authorization_expired"), expiredOrder);
      expect(releaseStep.status).toBe(200);
      expect(releaseStep.error).toBeNull();
      expect(releaseStep.stripe).toEqual([]);
      expect(releaseStep.stripeAccount).toBe("NONE");
      expect(releaseStep.untouched).toBe(true);
      expect(releaseStep.order).toEqual(expiredOrder);
      expect(releaseStep.dto?.capture?.status).toBe(PaymentCaptureStatus.AUTHORIZATION_EXPIRED);
      expect(reference.trail.audit).toEqual([
        ...AUTHORIZED_AUDIT,
        AuditAction.AUTHORIZATION_RELEASED,
      ]);
      expect(reference.trail.emails).toEqual(emails({ [EmailKind.PAYMENT_AUTHORIZED]: 1 }));
    }, 60_000);

    async function s15(lane: Lane) {
      const handle = await authorizedCarOrder(lane);
      const { paymentIntentId } = await idsOf(handle);
      const declined = await webhook(
        lane,
        handle,
        "payment_intent.payment_failed",
        buildPaymentIntentFailed({ paymentIntentId, message: CARD_DECLINED }),
      );
      const trailAfterDecline = await trailOf(handle);
      const captured = await capture(lane, handle);
      return { steps: [declined, captured], trailAfterDecline, trail: await trailOf(handle) };
    }

    it("S15 payment_intent.payment_failed on an AUTHORIZED order: CAPTURE_FAILED with the decline — status NOT FAILED; a capture afterwards succeeds", async () => {
      const { reference, rental } = await onBoth(s15);
      expect(rental).toEqual(reference);

      const [declined, captured] = reference.steps;
      expect(declined.status).toBe(200);
      expect(declined.reply).toEqual({
        received: true,
        handled: true,
        duplicate: false,
        orderId: "<ID>",
      });
      expect(declined.stripeAccount).toBe("OWN");
      expect(declined.order).toEqual({
        ...AUTHORIZED_ORDER,
        capture: {
          ...AUTHORIZED_CAPTURE,
          status: PaymentCaptureStatus.CAPTURE_FAILED,
          lastError: CARD_DECLINED,
        },
      });
      expect(declined.order.status).not.toBe(OrderStatus.FAILED);
      expect(declined.order.paymentStatus).not.toBe(OrderStatus.FAILED);
      expect(reference.trailAfterDecline.audit).toEqual([
        ...AUTHORIZED_AUDIT,
        AuditAction.PAYMENT_CAPTURE_FAILED,
      ]);

      expect(captured.status).toBe(200);
      expect(captured.stripe).toEqual([CAPTURE_CALL]);
      expect(captured.stripeAccount).toBe("OWN");
      expect(captured.order).toEqual(CAPTURED_ORDER);
      expect(reference.trail).toEqual({
        emails: emails({ [EmailKind.PAYMENT_AUTHORIZED]: 1, [EmailKind.PAYMENT_CONFIRMATION]: 1 }),
        audit: [
          ...AUTHORIZED_AUDIT,
          AuditAction.PAYMENT_CAPTURE_FAILED,
          AuditAction.PAYMENT_SUCCEEDED,
          AuditAction.PAYMENT_CAPTURED,
        ],
        evidence: [
          ...AUTHORIZED_EVIDENCE,
          OrderEvidenceEventType.PAYMENT_CAPTURE_FAILED,
          OrderEvidenceEventType.PAYMENT_COMPLETED,
          OrderEvidenceEventType.PAYMENT_CAPTURED,
        ],
      });
    }, 60_000);

    async function s16(lane: Lane) {
      const handle = await authorizedCarOrder(lane);
      const { sessionId } = await idsOf(handle);
      const expired = await webhook(
        lane,
        handle,
        "checkout.session.expired while authorized",
        buildCheckoutExpired({ sessionId, orderId: handle.id, orderNumber: handle.orderNumber }),
      );
      return { steps: [expired], trail: await trailOf(handle) };
    }

    it("S16 checkout.session.expired while AUTHORIZED is ignored: the hold stays live and capturable", async () => {
      const { reference, rental } = await onBoth(s16);
      expect(rental).toEqual(reference);

      const [expired] = reference.steps;
      expect(expired.status).toBe(200);
      expect(expired.reply).toEqual({
        received: true,
        handled: true,
        duplicate: true,
        orderId: "<ID>",
      });
      expect(expired.stripeAccount).toBe("OWN");
      expect(expired.untouched).toBe(true);
      expect(expired.order).toEqual(AUTHORIZED_ORDER);
      expect(reference.trail).toEqual({
        emails: emails({ [EmailKind.PAYMENT_AUTHORIZED]: 1 }),
        audit: AUTHORIZED_AUDIT,
        evidence: AUTHORIZED_EVIDENCE,
      });
    }, 60_000);
  });

  describe("S17 · who may capture and release", () => {
    async function s17(lane: Lane) {
      const held = await authorizedCarOrder(lane);
      const otherOrg = lane.other().orgId;
      const refusals = [
        await capture(lane, held, "STAFF captures", { actor: staff }),
        await release(lane, held, "STAFF releases", RELEASE_REASON, { actor: staff }),
        await capture(lane, held, "no session captures", { actor: null }),
        await release(lane, held, "no session releases", RELEASE_REASON, { actor: null }),
        await capture(lane, held, "ADMIN, the other organization selected, captures", {
          selected: otherOrg,
        }),
        await release(lane, held, "ADMIN, the other organization selected, releases", RELEASE_REASON, {
          selected: otherOrg,
        }),
      ];
      const heldOutcome = { steps: refusals, trail: await trailOf(held) };

      const second = await authorizedCarOrder(lane);
      const bySuperAdmin = await capture(lane, second, "SUPER_ADMIN captures", {
        actor: superAdmin,
      });
      return { held: heldOutcome, superAdmin: { steps: [bySuperAdmin], trail: await trailOf(second) } };
    }

    it("S17 STAFF → 403 on both routes; no session → 401; an operator with the OTHER organization selected → 404 'Order not found' — never a Stripe call; a SUPER_ADMIN captures (separate order)", async () => {
      const { reference, rental } = await onBoth(s17);
      expect(rental).toEqual(reference);

      const [staffCapture, staffRelease, anonCapture, anonRelease, otherCapture, otherRelease] =
        reference.held.steps;
      expectRefused(staffCapture, 403, MSG.forbidden, AUTHORIZED_ORDER);
      expectRefused(staffRelease, 403, MSG.forbidden, AUTHORIZED_ORDER);
      expectRefused(anonCapture, 401, MSG.unauthenticated, AUTHORIZED_ORDER);
      expectRefused(anonRelease, 401, MSG.unauthenticated, AUTHORIZED_ORDER);
      expectRefused(otherCapture, 404, MSG.notFound, AUTHORIZED_ORDER);
      expectRefused(otherRelease, 404, MSG.notFound, AUTHORIZED_ORDER);
      expect(reference.held.trail).toEqual({
        emails: emails({ [EmailKind.PAYMENT_AUTHORIZED]: 1 }),
        audit: AUTHORIZED_AUDIT,
        evidence: AUTHORIZED_EVIDENCE,
      });

      const [bySuperAdmin] = reference.superAdmin.steps;
      expect(bySuperAdmin.status).toBe(200);
      expect(bySuperAdmin.stripe).toEqual([CAPTURE_CALL]);
      expect(bySuperAdmin.stripeAccount).toBe("OWN");
      expect(bySuperAdmin.order).toEqual(CAPTURED_ORDER);
      expect(reference.superAdmin.trail.emails[EmailKind.PAYMENT_CONFIRMATION]).toBe(1);
    }, 60_000);
  });

  describe("S18–S20 · regenerate, archive, no intent yet", () => {
    async function s18(lane: Lane) {
      const handle = await authorizedCarOrder(lane);
      const steps = [
        await regenerate(lane, handle, "regenerate while authorized"),
        await release(lane, handle),
        await regenerate(lane, handle, "regenerate after release"),
        await authorize(lane, handle, "checkout.session.completed (unpaid) on the NEW session"),
        await release(lane, handle, "release the NEW hold"),
      ];
      return { steps, trail: await trailOf(handle) };
    }

    it("S18 regenerate while AUTHORIZED → 409 'This order has a live authorization…'; after the release → a NEW manual session (key order:<ID>:checkout:manual:regen:<uuid>), the capture back to PENDING_AUTHORIZATION, the authorization on the NEW intent recorded — and a release then acts on that NEW intent", async () => {
      const { reference, rental } = await onBoth(s18);
      expect(rental).toEqual(reference);

      const [whileAuthorized, released, regenerated, reauthorized, releasedAgain] =
        reference.steps;
      expectRefused(whileAuthorized, 409, MSG.liveAuthorization, AUTHORIZED_ORDER);
      expect(released.stripe).toEqual([CANCEL_CALL]);
      expect(released.order).toEqual(RELEASED_ORDER);

      expect(regenerated.status).toBe(200);
      expect(regenerated.error).toBeNull();
      expect(regenerated.stripe).toEqual([
        // reconcile first: has the customer completed checkout meanwhile?
        {
          method: "checkout.sessions.retrieve",
          target: "<CS_1>",
          onTheOrdersPaymentIntent: null,
          params: null,
          idempotencyKey: null,
        },
        {
          method: "checkout.sessions.create",
          target: null,
          onTheOrdersPaymentIntent: null,
          params: manualCarSession(),
          idempotencyKey: "order:<ID>:checkout:manual:regen:<UUID>",
        },
        // the replaced session is retired only after the new one is recorded
        {
          method: "checkout.sessions.expire",
          target: "<CS_1>",
          onTheOrdersPaymentIntent: null,
          params: null,
          idempotencyKey: null,
        },
      ]);
      expect(regenerated.stripeAccount).toBe("OWN");
      expect(regenerated.order).toEqual({
        ...AUTHORIZED_ORDER,
        status: OrderStatus.PAYMENT_PENDING,
        paymentStatus: OrderStatus.PAYMENT_PENDING,
        session: "<CS_2>",
        paymentIntent: "<PI_2>",
        capture: PENDING_CAPTURE,
      });

      expect(reauthorized.status).toBe(200);
      expect(reauthorized.reply).toEqual({
        received: true,
        handled: true,
        duplicate: false,
        orderId: "<ID>",
      });
      expect(reauthorized.order).toEqual({
        ...AUTHORIZED_ORDER,
        status: OrderStatus.PAYMENT_PENDING,
        paymentStatus: OrderStatus.PAYMENT_PENDING,
        session: "<CS_2>",
        paymentIntent: "<PI_2>",
      });

      // The hold now lives on <PI_2>; <PI_1> was released already. The key is
      // compared between the organizations above; absolutely, only that it
      // is this order's cancel key is pinned — not that it repeats the first
      // release's key verbatim for a different intent, which Stripe refuses
      // (the stub does not model idempotency).
      expect(releasedAgain.status).toBe(200);
      expect(releasedAgain.stripe).toHaveLength(1);
      expect(releasedAgain.stripe[0]).toMatchObject({
        method: "paymentIntents.cancel",
        target: "<PI_2>",
        onTheOrdersPaymentIntent: true,
        params: { cancellation_reason: "abandoned" },
      });
      // Keyed per HOLD: the second hold's release carries its own key, never
      // the first release's (Stripe refuses a key reused with different
      // parameters, and would replay the first release instead).
      expect(releasedAgain.stripe[0]!.idempotencyKey).toBe("order:<ID>:cancel:<PI_2>");
      expect(releasedAgain.stripeAccount).toBe("OWN");
      expect(releasedAgain.order).toEqual({
        ...RELEASED_ORDER,
        status: OrderStatus.PAYMENT_PENDING,
        paymentStatus: OrderStatus.PAYMENT_PENDING,
        session: "<CS_2>",
        paymentIntent: "<PI_2>",
      });
      expect(reference.trail).toEqual({
        // One "card authorized" email per authorization; never a receipt.
        emails: emails({ [EmailKind.PAYMENT_AUTHORIZED]: 2 }),
        audit: [
          ...AUTHORIZED_AUDIT,
          AuditAction.AUTHORIZATION_RELEASED,
          // regenerate's reconcile found <CS_1> complete/unpaid on a hold
          // already released: nothing is recorded again — not even a
          // duplicate-event row.
          AuditAction.ORDER_PAYMENT_LINK_REGENERATED,
          AuditAction.PAYMENT_AUTHORIZED,
          AuditAction.AUTHORIZATION_RELEASED,
        ],
        evidence: [
          ...AUTHORIZED_EVIDENCE,
          OrderEvidenceEventType.AUTHORIZATION_RELEASED,
          OrderEvidenceEventType.PAYMENT_LINK_REGENERATED,
          OrderEvidenceEventType.PAYMENT_AUTHORIZED,
          OrderEvidenceEventType.AUTHORIZATION_RELEASED,
        ],
      });
    }, 60_000);

    async function s19(lane: Lane) {
      // A LIVE hold: archiving is refused until the hold is released.
      const held = await authorizedCarOrder(lane);
      const heldSteps = [
        await archive(lane, held),
        await release(lane, held),
        await archive(lane, held),
      ];
      // An order archived BEFORE its authorization landed: capture and
      // release are refused on it.
      const { handle: pending } = await linkedCarOrder(lane);
      const pendingSteps = [
        await archive(lane, pending),
        await capture(lane, pending),
        await release(lane, pending),
      ];
      return {
        steps: [...heldSteps, ...pendingSteps],
        trail: await trailOf(held),
        pendingTrail: await trailOf(pending),
      };
    }

    it("S19 archive: a LIVE hold is refused (409 'This order has a live card hold…', order untouched — an archived order could be neither captured nor released) and archives once released; an order archived before its authorization → 409 'Cannot act on an archived order' for capture and release", async () => {
      const { reference, rental } = await onBoth(s19);
      expect(rental).toEqual(reference);

      const [refused, released, archivedReleased, archivedPending, captureStep, releaseStep] =
        reference.steps;
      expectRefused(refused, 409, MSG.liveHoldArchive, AUTHORIZED_ORDER);
      expect(released.status).toBe(200);
      expect(released.order).toEqual(RELEASED_ORDER);
      expect(archivedReleased.status).toBe(200);
      expect(archivedReleased.order).toEqual({ ...RELEASED_ORDER, state: RecordState.ARCHIVED });
      expect(reference.trail.audit).toEqual([
        ...AUTHORIZED_AUDIT,
        AuditAction.AUTHORIZATION_RELEASED,
        AuditAction.ORDER_ARCHIVED,
      ]);

      const archivedBeforeAuthorization: OrderState = {
        ...AUTHORIZED_ORDER,
        state: RecordState.ARCHIVED,
        capture: PENDING_CAPTURE,
      };
      expect(archivedPending.status).toBe(200);
      expect(archivedPending.order).toEqual(archivedBeforeAuthorization);
      expectRefused(captureStep, 409, MSG.archived, archivedBeforeAuthorization);
      expectRefused(releaseStep, 409, MSG.archived, archivedBeforeAuthorization);
    }, 60_000);

    async function s20(lane: Lane) {
      const { handle } = await linkedCarOrder(lane);
      // Production's Checkout sessions carry no PaymentIntent until the
      // customer authorizes.
      await setRaw(handle, { "payment.paymentIntentId": null });
      const steps = [await release(lane, handle), await capture(lane, handle)];
      return { steps, trail: await trailOf(handle) };
    }

    it("S20 no PaymentIntent yet (PENDING_AUTHORIZATION, intent null): release AND capture → 409 'This order has no payment intent to act on yet.' — the intent check precedes the status check", async () => {
      const { reference, rental } = await onBoth(s20);
      expect(rental).toEqual(reference);

      const awaiting: OrderState = {
        ...AUTHORIZED_ORDER,
        paymentIntent: null,
        capture: PENDING_CAPTURE,
      };
      const [releaseStep, captureStep] = reference.steps;
      expectRefused(releaseStep, 409, MSG.noIntentYet, awaiting);
      expectRefused(captureStep, 409, MSG.noIntentYet, awaiting);
    }, 60_000);
  });

  describe("S21 · beyond the matrix: an order stored WITHOUT an organization", () => {
    /** The reference runs its own order; Rental runs one stored with
     *  `organizationId: null` — a pre-organization row, which is the default
     *  organization's everywhere (scope, gateway, deployment endpoint). */
    async function s21(lane: Lane) {
      const { handle, created } = await createCarOrder(lane);
      if (lane.key === "rentalconfirmation") await setRaw(handle, { organizationId: null });
      const steps = [
        created,
        await generateLink(lane, handle),
        await authorize(lane, handle),
        await capture(lane, handle, "ADMIN, the other organization selected, captures", {
          selected: lane.other().orgId,
        }),
        await capture(lane, handle),
      ];
      // Which organization the order is stored under, as it ends — kept out
      // of the comparison: it is the one thing that differs by design.
      const stored = await Order.collection.findOne({ _id: new Types.ObjectId(handle.id) });
      return {
        outcome: { steps, trail: await trailOf(handle) },
        storedOrganizationId: stored?.organizationId ? String(stored.organizationId) : null,
      };
    }

    it("S21 Rental's legacy order runs the reference's lifecycle: a manual link on the deployment account (NEW: the default organization's mode applies), authorized through the deployment endpoint, invisible to the other organization, captured", async () => {
      const { reference: ref, rental: rc } = await onBoth(s21);
      expect(rc.outcome).toEqual(ref.outcome);
      // The reference's order is its own; Rental's really is stored without
      // an organization, start to finish.
      expect(ref.storedOrganizationId).toBe(String(lanes.tripreservations.orgId));
      expect(rc.storedOrganizationId).toBeNull();

      const reference = ref.outcome;
      const [created, linked, authorized, fromOtherOrg, captured] = reference.steps;
      expect(created).toMatchObject({ status: 201, error: null, stripe: [], stripeAccount: "NONE" });
      expect(created.order).toMatchObject({ status: OrderStatus.NOT_INITIATED, capture: null });
      expect(linked.stripe).toEqual([
        {
          method: "checkout.sessions.create",
          target: null,
          onTheOrdersPaymentIntent: null,
          params: manualCarSession(),
          idempotencyKey: "order:<ID>:checkout:manual",
        },
      ]);
      expect(linked.stripeAccount).toBe("OWN");
      expect(linked.order).toEqual({ ...AUTHORIZED_ORDER, capture: PENDING_CAPTURE });
      expect(authorized.reply).toEqual({
        received: true,
        handled: true,
        duplicate: false,
        orderId: "<ID>",
      });
      expect(authorized.stripeAccount).toBe("OWN");
      expect(authorized.order).toEqual(AUTHORIZED_ORDER);
      expectRefused(fromOtherOrg, 404, MSG.notFound, AUTHORIZED_ORDER);
      expect(captured.stripe).toEqual([CAPTURE_CALL]);
      expect(captured.stripeAccount).toBe("OWN");
      expect(captured.order).toEqual(CAPTURED_ORDER);
      expect(reference.trail.emails).toEqual(
        emails({ [EmailKind.PAYMENT_AUTHORIZED]: 1, [EmailKind.PAYMENT_CONFIRMATION]: 1 }),
      );
      expect(reference.trail.audit).toEqual([
        ...AUTHORIZED_AUDIT,
        AuditAction.PAYMENT_SUCCEEDED,
        AuditAction.PAYMENT_CAPTURED,
      ]);
    }, 60_000);
  });
});
