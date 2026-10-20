import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import type Stripe from "stripe";

import { DELETE as archiveOrderRoute } from "@/app/api/orders/[id]/route";
import { POST as reconcileRoute } from "@/app/api/orders/[id]/reconcile/route";
import { POST as regenerateLinkRoute } from "@/app/api/orders/[id]/regenerate-link/route";
import { POST as sendRequestRoute } from "@/app/api/orders/[id]/send-payment-request/route";
import { POST as deploymentWebhook } from "@/app/api/webhooks/stripe/route";
import {
  AuditAction,
  BookingStatus,
  CaptureMode,
  EmailKind,
  OrderEvidenceEventType,
  OrderStatus,
  PaymentCaptureStatus,
  PaymentGatewayKey,
  RecordState,
  UserRole,
} from "@/lib/constants/enums";
import { PaymentError } from "@/lib/errors";
import {
  AuditLog,
  Order,
  OrderEvidence,
  Organization,
  OrganizationMember,
  PendingEmail,
  ProcessedWebhookEvent,
} from "@/server/db/models";
import { orgCookieName } from "@/server/auth/org-cookie";
import {
  createOrder,
  initiatePayment,
  reconcileOrderPayment,
  regeneratePaymentLink,
  type ReconcileResult,
} from "@/server/services/order.service";
import {
  cancelAuthorization,
  capturePayment,
} from "@/server/services/payment-capture.service";
import { createSettings } from "@/tests/factories/settings.factory";
import {
  buildAmountCapturableUpdated,
  buildCheckoutCompleted,
  buildPaymentIntentCanceled,
  buildPaymentIntentFailed,
  signWebhook,
} from "@/tests/factories/stripe-event.factory";
import { validCreateOrderInput } from "@/tests/fixtures/order-input.fixture";
import { getCurrentTestStripe } from "@/tests/setup/integration.setup";
import {
  buildRequest,
  expectOk,
  jsonBody,
  type ApiEnvelope,
} from "@/tests/utils/api";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { ensureMongo } from "@/tests/utils/db";
import { setNextHeaders } from "@/tests/utils/next-headers";
import type { OrderDTO } from "@/types";

/**
 * The manual-capture lifecycle guards, on Rental Confirmation — the DEFAULT
 * organization, switched to MANUAL the way
 * `scripts/set-organization-capture-mode.ts` does it — with its Stripe events
 * posted to the deployment endpoint, POST /api/webhooks/stripe:
 *
 *  1. payment_intent.canceled releases only the order's CURRENT hold. An
 *     order that knows its intent compares it directly; before its
 *     authorization lands it knows none (in production a Checkout Session
 *     has no PaymentIntent until the customer pays), so Stripe is asked which
 *     intent the order's current session holds. Any other intent — typically
 *     the one a regenerated link retired — is history: claimed once, audited
 *     PAYMENT_SESSION_SUPERSEDED, the order untouched. The write itself is
 *     pinned to the hold that check saw.
 *  2. payment_intent.payment_failed while the hold stands (AUTHORIZED,
 *     CAPTURE_PENDING, CAPTURE_FAILED) is a declined capture, never a failed
 *     order: claimed once, recorded only while the hold still stands — not
 *     once it was captured or released meanwhile.
 *  3. An operator's release records CANCELLED only on the intent it voided.
 *  4. A link is never regenerated over a CAPTURE_FAILED hold — refused at
 *     each of regeneratePaymentLink's three checks.
 *  5. No payment request goes out once the order is past its checkout,
 *     whether or not one went out before (the operator may have shared the
 *     link directly); it still goes out before the customer authorizes and
 *     for an automatic-capture order.
 *  6. payment_intent.payment_failed follows 1's rule on a manual-capture
 *     order (an automatic-capture order handles its declines exactly as
 *     before, with no session lookup). Stripe retries an unacknowledged delivery
 *     for days, so link A's decline can land after the operator issued link
 *     B: decided the same way (the recorded intent, else Stripe's answer for
 *     the current session), it is history — claimed once, audited
 *     PAYMENT_SESSION_SUPERSEDED, the order untouched: still PAYMENT_PENDING,
 *     its request still goes out. A lookup that fails answers 500. A decline
 *     for the current session's intent fails the order exactly as before.
 *  7. A card declined at checkout fails the order while its hold is still
 *     pending; another card authorized on the same, still-open session puts
 *     it back in progress (PAYMENT_PENDING, the failure cleared, one
 *     PAYMENT_AUTHORIZED email) and the operator captures it. An
 *     automatic-capture order declined, then paid, ends PAID as before.
 *  8. Reconcile adds nothing to a hold already on record (AUTHORIZED,
 *     CAPTURE_PENDING, CAPTURE_FAILED) while Stripe reports its session
 *     complete and unpaid — no claim, no duplicate-event row, however often
 *     the order page or the success page asks — and settles one Stripe
 *     reports paid (a capture whose answer never reached us): PAID, the
 *     capture CAPTURED, the booking CONFIRMED, one receipt.
 *  9. An order is never archived over a live card hold (AUTHORIZED,
 *     CAPTURE_PENDING, CAPTURE_FAILED) — archived, it could be neither
 *     captured nor released. It still archives before its authorization,
 *     once the hold is released or lapsed, and on automatic capture.
 *
 * Without 1, the motivating failure: a card declined on link A, the operator
 * regenerates (link B), Stripe then cancels A's intent — and B's hold was
 * cancelled before the customer ever opened it, so their authorization was
 * dropped and the operator's Capture refused.
 *
 * The Stripe stub mints a PaymentIntent with every Checkout Session and the
 * app records it on the order; tests that need production's shape clear it
 * themselves (`withoutRecordedIntent`). That includes every link a race
 * regenerates: left on it, the stub's intent would make a write pinned to
 * "this intent, or none yet" look safe when in production it is not.
 */

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

const admin = actorFor(UserRole.ADMIN, { name: "Admin User" });
const DEPLOYMENT_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET!;
const CUSTOMER_EMAIL = "ada@payops.test";

/** What the operator is told, verbatim. */
const LIVE_AUTHORIZATION =
  "This order has a live authorization. Release the authorization before generating a new payment link.";
const CHECKOUT_ALREADY_COMPLETED =
  "The customer has already completed checkout on the existing payment link, so no new link was issued. Refresh the order to see it.";
const CHANGED_WHILE_REGENERATING =
  "This order changed while its payment link was being regenerated. Refresh and try again.";
const ALREADY_AUTHORIZED =
  "The customer has already authorized this payment. Capture or release the hold instead of sending another request.";
const HOLD_RELEASED =
  "This order's card hold was released. Generate a new payment link before sending another request.";
const ORDER_FAILED = "Cannot send a request — order is failed.";
const LIVE_HOLD_ARCHIVE =
  "This order has a live card hold. Capture or release it before archiving.";

const CARD_DECLINED = "Your card was declined.";
const INSUFFICIENT_FUNDS = "Your card has insufficient funds.";
const CAPTURE_TIMED_OUT = "Request to Stripe timed out";

type CancellationReason = "abandoned" | "automatic";

let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;
let rental: Types.ObjectId;

/** Rental Confirmation as production stores it, then switched to MANUAL
 *  with the script's narrow write. */
async function makeRental(): Promise<Types.ObjectId> {
  const doc = await Organization.create({
    slug: "rentalconfirmation",
    name: "Rental Confirmation",
    brandName: "Rental Confirmation",
    isDefault: true,
    payments: {
      provider: PaymentGatewayKey.STRIPE,
      enabledProviders: [PaymentGatewayKey.STRIPE],
    },
  });
  const id = doc._id as Types.ObjectId;
  await Organization.collection.updateOne(
    { _id: id },
    { $unset: { serviceTypes: "", legal: "", "payments.captureMode": "" } },
  );
  await setRentalMode(CaptureMode.MANUAL);
  await OrganizationMember.create({
    organizationId: id,
    userId: new Types.ObjectId(admin.id),
    role: admin.role,
    status: RecordState.ACTIVE,
  });
  return id;
}

async function setRentalMode(mode: CaptureMode) {
  await Organization.collection.updateOne(
    { slug: "rentalconfirmation" },
    { $set: { "payments.captureMode": mode } },
  );
}

/* ------------------------------------------------------------------ *
 * Stripe → the deployment endpoint
 * ------------------------------------------------------------------ */

interface WebhookReply {
  received: true;
  handled: boolean;
  duplicate: boolean;
  orderId?: string;
  reason?: string;
}

type Caller = "operator" | "stripe" | "customer";

/** Whose request is being served. Stripe's and the customer's carry none of
 *  the operator's cookies — no organization selected — and the races below
 *  land one caller's request in the middle of the other's. */
const callers: Caller[] = [];

async function inRequestOf<T>(caller: Caller, run: () => Promise<T>): Promise<T> {
  const enter = (c: Caller | undefined) =>
    c === "stripe" || c === "customer" ? setNextHeaders({}) : actingAsOperator();
  callers.push(caller);
  enter(caller);
  try {
    return await run();
  } finally {
    callers.pop();
    enter(callers.at(-1));
  }
}

/** POST /api/webhooks/stripe as Stripe makes it: signed with the deployment
 *  secret, and no operator cookies. */
async function post(event: Stripe.Event) {
  const payload = JSON.stringify(event);
  return inRequestOf("stripe", async () =>
    jsonBody<ApiEnvelope<WebhookReply>>(
      await deploymentWebhook(
        buildRequest("/api/webhooks/stripe", {
          method: "POST",
          body: payload,
          headers: {
            "stripe-signature": signWebhook(payload, DEPLOYMENT_WEBHOOK_SECRET),
          },
        }),
      ),
    ),
  );
}

/** A delivery Stripe sees acknowledged (200), and the endpoint's verdict. */
async function deliver(event: Stripe.Event): Promise<WebhookReply> {
  const { status, body } = await post(event);
  expect(status, JSON.stringify(body)).toBe(200);
  expectOk(body);
  return body.data;
}

type OrderRef = Pick<OrderDTO, "id" | "orderNumber">;

/** payment_intent.canceled, carrying the order's metadata as every intent a
 *  checkout creates does. */
function intentCanceled(
  order: OrderRef,
  paymentIntentId: string,
  cancellationReason: CancellationReason,
): Stripe.Event {
  return buildPaymentIntentCanceled({
    paymentIntentId,
    orderId: order.id,
    orderNumber: order.orderNumber,
    cancellationReason,
  });
}

/** payment_intent.payment_failed for a card declined at checkout. Stripe's
 *  event carries the order's metadata, which is how it finds an order that
 *  does not know its intent yet; the factory's event carries none. */
function declinedAtCheckout(order: OrderRef, paymentIntentId: string): Stripe.Event {
  const event = buildPaymentIntentFailed({ paymentIntentId, message: CARD_DECLINED });
  Object.assign(event.data.object, {
    metadata: { orderId: order.id, orderNumber: order.orderNumber },
  });
  return event;
}

/** checkout.session.completed for `session`, as Stripe sends it once a card
 *  goes through: "unpaid" when a manual-capture checkout authorized it,
 *  "paid" when an automatic one charged it. */
function checkoutCompleted(
  order: OrderRef,
  session: StubSession,
  paymentIntentId: string,
  paymentStatus: "paid" | "unpaid",
): Stripe.Event {
  return buildCheckoutCompleted({
    sessionId: session.id,
    paymentIntentId,
    orderId: order.id,
    orderNumber: order.orderNumber,
    amountTotal: session.amount_total ?? undefined,
    customerEmail: CUSTOMER_EMAIL,
    paymentStatus,
  });
}

/* ------------------------------------------------------------------ *
 * The operator, the customer and the order
 * ------------------------------------------------------------------ */

function actingAsOperator() {
  setNextHeaders({ cookies: { [orgCookieName()]: String(rental) } });
}

async function linkedOrder(): Promise<OrderDTO> {
  actingAsOperator();
  const { order } = await createOrder(validCreateOrderInput(), { actor: admin });
  const { order: initiated } = await initiatePayment(order.id, { actor: admin });
  return initiated;
}

async function reload(orderId: string) {
  const doc = await Order.findById(orderId).lean();
  if (!doc) throw new Error(`Order ${orderId} vanished`);
  return doc;
}

/** payment_intent.amount_capturable_updated: the customer authorized
 *  `paymentIntentId` (by default the intent the order holds). */
async function authorize(orderId: string, paymentIntentId?: string) {
  const doc = await reload(orderId);
  const reply = await deliver(
    buildAmountCapturableUpdated({
      paymentIntentId: paymentIntentId ?? doc.payment.paymentIntentId!,
      orderId,
      orderNumber: doc.orderNumber,
      amountCapturable: Math.round(doc.pricing.amount * 100),
    }),
  );
  expect(reply).toMatchObject({ handled: true, duplicate: false });
  const after = await reload(orderId);
  expect(after.payment.capture?.status).toBe(PaymentCaptureStatus.AUTHORIZED);
  return after;
}

/** The operator's "Capture payment", declined by Stripe. */
async function declinedCapture(orderId: string, message = CARD_DECLINED) {
  getCurrentTestStripe().failNextCapture({ code: "card_declined", message });
  await expect(capturePayment(orderId, { actor: admin })).rejects.toBeInstanceOf(
    PaymentError,
  );
  const after = await reload(orderId);
  expect(after.payment.capture?.status).toBe(PaymentCaptureStatus.CAPTURE_FAILED);
  return after;
}

/**
 * The operator's "Capture payment", with `during` run while it is in flight
 * (the order says CAPTURE_PENDING): before Stripe takes the money, or — with
 * `stripeFirst` — once Stripe has taken it and its answer is not back yet.
 * The capture then completes.
 */
async function whileCapturing(
  orderId: string,
  during: () => Promise<void>,
  { stripeFirst = false } = {},
) {
  const intents = stripeIntents();
  const realCapture = intents.capture.bind(intents) as (...args: unknown[]) => Promise<unknown>;
  let inFlight: string | null | undefined;
  vi.spyOn(intents, "capture").mockImplementationOnce((async (...args: unknown[]) => {
    inFlight = (await reload(orderId)).payment.capture?.status;
    if (!stripeFirst) {
      await during();
      return realCapture(...args);
    }
    const answer = await realCapture(...args);
    await during();
    return answer;
  }) as never);

  await capturePayment(orderId, { actor: admin });

  expect(inFlight).toBe(PaymentCaptureStatus.CAPTURE_PENDING);
  const captured = await reload(orderId);
  expect(captured.status).toBe(OrderStatus.PAID);
  expect(captured.payment.capture?.status).toBe(PaymentCaptureStatus.CAPTURED);
  return captured;
}

const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

/** POST /api/orders/[id]/regenerate-link — the order page's button. */
async function regenerate(orderId: string) {
  return jsonBody<ApiEnvelope<{ order: OrderDTO }>>(
    await regenerateLinkRoute(
      buildRequest(`/api/orders/${orderId}/regenerate-link`, { method: "POST", body: {} }),
      idParams(orderId),
    ),
  );
}

/** POST /api/orders/[id]/send-payment-request as the composer posts it: the
 *  reply, and the payment-request emails that left. */
async function sendRequest(orderId: string) {
  const mark = sentMail.length;
  const { status, body } = await jsonBody<ApiEnvelope<{ order: OrderDTO }>>(
    await sendRequestRoute(
      buildRequest(`/api/orders/${orderId}/send-payment-request`, { method: "POST", body: {} }),
      idParams(orderId),
    ),
  );
  const emails = sentMail
    .slice(mark)
    .filter(
      (m) =>
        (m.headers as Record<string, string> | undefined)?.["X-Entity-Kind"] ===
        EmailKind.PAYMENT_LINK,
    );
  return { status, body, emails };
}

/** DELETE /api/orders/[id] — the order page's Archive button. */
async function archive(orderId: string) {
  return jsonBody<ApiEnvelope<OrderDTO>>(
    await archiveOrderRoute(
      buildRequest(`/api/orders/${orderId}`, {
        method: "DELETE",
        body: { reason: "Customer changed plans" },
      }),
      idParams(orderId),
    ),
  );
}

/** POST /api/orders/[id]/reconcile — what the order page fires on each visit
 *  while the order is LINK_GENERATED or PAYMENT_PENDING, and its "Check
 *  payment with Stripe" button. */
async function reconcileFromOrderPage(orderId: string): Promise<ReconcileResult> {
  const { status, body } = await jsonBody<ApiEnvelope<ReconcileResult>>(
    await reconcileRoute(
      buildRequest(`/api/orders/${orderId}/reconcile`, { method: "POST", body: {} }),
      idParams(orderId),
    ),
  );
  expect(status, JSON.stringify(body)).toBe(200);
  expectOk(body);
  return body.data;
}

/** The customer's visit to /pay/success: reconciled on the session Stripe
 *  sent them back with, carrying none of the operator's cookies. */
function reconcileFromSuccessPage(orderId: string, sessionId: string) {
  return inRequestOf("customer", () =>
    reconcileOrderPayment(orderId, undefined, { sessionId }),
  );
}

/* ------------------------------------------------------------------ *
 * The Stripe stub
 * ------------------------------------------------------------------ */

function stripeSessions() {
  return getCurrentTestStripe().asStripe().checkout.sessions;
}

function stripeIntents() {
  return getCurrentTestStripe().asStripe().paymentIntents;
}

interface StubSession {
  id: string;
  payment_intent: string | null;
  status: string;
  payment_status?: string;
  amount_total: number | null;
}

/** The order's current Checkout Session as Stripe reports it from now on —
 *  the stub's own record, so a test can change what Stripe says. */
async function stripeSessionOf(orderId: string): Promise<StubSession> {
  const { payment } = await reload(orderId);
  const found = getCurrentTestStripe().sessionsCreated.find(
    (s) => s.result.id === payment.stripeSessionId,
  );
  if (!found) throw new Error(`No Stripe session ${payment.stripeSessionId}`);
  return found.result as unknown as StubSession;
}

/**
 * The order as production stores it until its authorization lands: no
 * `payment.paymentIntentId`. Returns the current session and the intent
 * Stripe creates behind it once the customer submits their card (the
 * session reports it until a test says otherwise).
 */
async function withoutRecordedIntent(orderId: string) {
  const session = await stripeSessionOf(orderId);
  const intentId = session.payment_intent!;
  await Order.collection.updateOne(
    { _id: new Types.ObjectId(orderId) },
    { $set: { "payment.paymentIntentId": null } },
  );
  expect((await reload(orderId)).payment.paymentIntentId).toBeNull();
  return { session, intentId };
}

/** How the order stands when Stripe's event about link A lands. */
type IntentShape = "recorded" | "unopened" | "opened";

const INTENT_SHAPES: Record<IntentShape, string> = {
  recorded: "the order knows link B's intent (compared directly, Stripe not asked)",
  unopened:
    "the order knows no intent (production) and Stripe says link B holds none yet",
  opened:
    "the order knows no intent (production) and Stripe says link B holds its own",
};

/**
 * Link A replaced by link B with the order page's button, the order then
 * standing as `shape` says. Returns A's intent, and link B's session and
 * intent as Stripe reports them from now on.
 */
async function replacedLink(shape: IntentShape) {
  const linked = await linkedOrder();
  const sessionA = await stripeSessionOf(linked.id);
  const intentA = sessionA.payment_intent!;
  const res = await regenerate(linked.id);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  // Retiring A at Stripe is what makes its intent history.
  expect(getCurrentTestStripe().sessionsExpired).toEqual([sessionA.id]);
  const sessionB = await stripeSessionOf(linked.id);
  const intentB = sessionB.payment_intent!;
  expect(intentB).not.toBe(intentA);
  if (shape !== "recorded") await withoutRecordedIntent(linked.id);
  if (shape === "unopened") sessionB.payment_intent = null;
  const relinked = await reload(linked.id);
  expect(relinked.status).toBe(OrderStatus.PAYMENT_PENDING);
  expect(relinked.payment.paymentIntentId).toBe(shape === "recorded" ? intentB : null);
  return { linked, intentA, sessionB, intentB, relinked };
}

/* ------------------------------------------------------------------ *
 * The trail
 * ------------------------------------------------------------------ */

const auditsOf = (orderId: string, action: AuditAction) =>
  AuditLog.find({ entityId: orderId, action }).sort({ createdAt: 1 }).lean();

/** Evidence entries of one type — or only those recorded for one Stripe
 *  event, so an operator attempt's own trail is not counted with it. */
const evidenceOf = (
  orderId: string,
  eventType: OrderEvidenceEventType,
  gatewayEventId?: string,
) =>
  OrderEvidence.countDocuments({
    orderId: new Types.ObjectId(orderId),
    eventType,
    ...(gatewayEventId ? { "refs.gatewayEventId": gatewayEventId } : {}),
  });

const emailsQueued = (orderId: string, kind: EmailKind) =>
  PendingEmail.countDocuments({ orderId: new Types.ObjectId(orderId), kind });

/** Payment links recorded for the order: the first one, then one per
 *  regeneration (both are audited ORDER_PAYMENT_LINK_REGENERATED). */
const linksRecorded = (orderId: string) =>
  AuditLog.countDocuments({
    entityId: orderId,
    action: AuditAction.ORDER_PAYMENT_LINK_REGENERATED,
  });

const meta = (row: { metadata?: unknown } | undefined) =>
  (row?.metadata ?? {}) as Record<string, unknown>;

/** All a request could leave behind about the order: its audit rows — a
 *  duplicate-event row is keyed by the event id and names the order in its
 *  metadata — and the event ids claimed for it. */
async function trailOf(orderId: string) {
  const [audits, claims] = await Promise.all([
    AuditLog.find({ $or: [{ entityId: orderId }, { "metadata.orderId": orderId }] })
      .sort({ _id: 1 })
      .lean(),
    ProcessedWebhookEvent.find({ orderId: new Types.ObjectId(orderId) })
      .sort({ _id: 1 })
      .lean(),
  ]);
  return {
    audits: audits.map((row) => row.action),
    claims: claims.map((row) => row.gatewayEventId),
  };
}

/** The order as stored, and its trail. */
async function snapshot(orderId: string) {
  return { order: await reload(orderId), trail: await trailOf(orderId) };
}

type Snapshot = Awaited<ReturnType<typeof snapshot>>;

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  sentMail.length = 0;
  callers.length = 0;
  sessionMock = await mockSession(admin);
  rental = await makeRental();
  actingAsOperator();
});

afterEach(() => {
  sessionMock?.restore();
  sessionMock = null;
  setNextHeaders({});
});

describe("1 · payment_intent.canceled releases only the order's CURRENT hold", () => {
  describe("once the authorization has landed the order knows its intent, and compares it directly", () => {
    it("an event for an intent the order no longer holds is history: reply 'superseded_payment_intent', the order untouched, ONE PAYMENT_SESSION_SUPERSEDED audit naming both intents and the current session, Stripe not asked; a replay is a duplicate; the order's own intent still releases it", async () => {
      const linked = await linkedOrder();
      const held = await authorize(linked.id);
      const current = held.payment.paymentIntentId!;
      const retrieve = vi.spyOn(stripeSessions(), "retrieve");
      const stale = intentCanceled(linked, "pi_test_replaced_hold", "abandoned");

      expect(await deliver(stale)).toEqual({
        received: true,
        handled: true,
        duplicate: false,
        orderId: linked.id,
        reason: "superseded_payment_intent",
      });

      const after = await reload(linked.id);
      expect(after.payment).toEqual(held.payment);
      expect(after.bookingStatus).toBe(BookingStatus.PENDING);
      expect(after.status).toBe(held.status);
      const superseded = await auditsOf(linked.id, AuditAction.PAYMENT_SESSION_SUPERSEDED);
      expect(superseded).toHaveLength(1);
      expect(String(superseded[0]!.organizationId)).toBe(String(rental));
      expect(superseded[0]!.metadata).toMatchObject({
        eventId: stale.id,
        type: "payment.cancelled",
        paymentIntentId: "pi_test_replaced_hold",
        currentPaymentIntentId: current,
        currentSessionId: held.payment.stripeSessionId,
      });
      expect(await auditsOf(linked.id, AuditAction.AUTHORIZATION_RELEASED)).toHaveLength(0);
      expect(await evidenceOf(linked.id, OrderEvidenceEventType.AUTHORIZATION_RELEASED)).toBe(0);
      expect(retrieve).not.toHaveBeenCalled();

      expect(await deliver(stale)).toMatchObject({ handled: true, duplicate: true });
      expect(await auditsOf(linked.id, AuditAction.PAYMENT_SESSION_SUPERSEDED)).toHaveLength(1);
      expect((await reload(linked.id)).payment).toEqual(held.payment);

      expect(await deliver(intentCanceled(linked, current, "automatic"))).toEqual({
        received: true,
        handled: true,
        duplicate: false,
        orderId: linked.id,
      });
      const lapsed = await reload(linked.id);
      expect(lapsed.payment.capture?.status).toBe(PaymentCaptureStatus.AUTHORIZATION_EXPIRED);
      expect(lapsed.bookingStatus).toBe(BookingStatus.CANCELLED);
    });

    it("the hold lapses at Stripe while the operator releases it and issues a new link: Stripe's notice, read before them and written after, leaves the new link's re-armed hold (no intent yet) untouched — the write is pinned to the intent it checked", async () => {
      const linked = await linkedOrder();
      const held = await authorize(linked.id);
      const lapsedIntent = held.payment.paymentIntentId!;
      let relinked: OrderDTO | undefined;

      // The handler has read the order — AUTHORIZED, on the lapsed intent —
      // when the operator's release and new link commit.
      const findById = Order.findById.bind(Order);
      vi.spyOn(Order, "findById").mockImplementationOnce(((id: string) => {
        const read = findById(id);
        return {
          then: (
            resolve: (value: unknown) => unknown,
            reject: (reason: unknown) => unknown,
          ) =>
            read
              .then(async (doc) => {
                await inRequestOf("operator", async () => {
                  await cancelAuthorization(
                    linked.id,
                    { actor: admin },
                    { reason: "Supplier could not confirm" },
                  );
                  ({ order: relinked } = await regeneratePaymentLink(linked.id, { actor: admin }));
                });
                // As production stores the new link: no intent until the
                // customer pays. With the stub's minted intent left on it, a
                // write pinned to "the lapsed intent, or none yet" would pass.
                await withoutRecordedIntent(linked.id);
                return doc;
              })
              .then(resolve, reject),
        };
      }) as unknown as typeof Order.findById);

      expect(await deliver(intentCanceled(linked, lapsedIntent, "automatic"))).toMatchObject({
        handled: true,
      });
      expect(relinked).toBeDefined();
      // The check passed (the handler saw the lapsed intent as current), so
      // only the write's pin stood between Stripe's notice and the new link.
      expect(await auditsOf(linked.id, AuditAction.PAYMENT_SESSION_SUPERSEDED)).toHaveLength(0);

      const after = await reload(linked.id);
      expect(after.payment.stripeSessionId).toBe(relinked!.payment.paymentSessionId);
      expect(after.payment.stripeSessionId).not.toBe(held.payment.stripeSessionId);
      expect(after.payment.paymentIntentId).toBeNull();
      expect(after.payment.capture).toMatchObject({
        method: CaptureMode.MANUAL,
        status: PaymentCaptureStatus.PENDING_AUTHORIZATION,
        cancelledAt: null,
        cancelReason: null,
      });
      expect(after.bookingStatus).toBe(BookingStatus.PENDING);
      expect(after.status).toBe(OrderStatus.PAYMENT_PENDING);
      // Only the operator's release is on record — nothing says a hold lapsed.
      const released = await auditsOf(linked.id, AuditAction.AUTHORIZATION_RELEASED);
      expect(released.map((row) => meta(row).releasedBy)).toEqual(["operator"]);
    });
  });

  describe("before the authorization lands the order holds no intent (production), so Stripe is asked which intent the order's current session holds", () => {
    it.each([
      { reason: "automatic", status: PaymentCaptureStatus.AUTHORIZATION_EXPIRED },
      { reason: "abandoned", status: PaymentCaptureStatus.CANCELLED },
    ] as const)(
      "Stripe says the current session holds the event's intent → applied: cancellation_reason '$reason' → $status, booking CANCELLED, order status untouched",
      async ({ reason, status }) => {
        const linked = await linkedOrder();
        const { session, intentId } = await withoutRecordedIntent(linked.id);
        const retrieve = vi.spyOn(stripeSessions(), "retrieve");

        expect(await deliver(intentCanceled(linked, intentId, reason))).toEqual({
          received: true,
          handled: true,
          duplicate: false,
          orderId: linked.id,
        });

        expect(retrieve).toHaveBeenCalledTimes(1);
        expect(retrieve).toHaveBeenCalledWith(session.id);
        const after = await reload(linked.id);
        expect(after.payment.capture?.status).toBe(status);
        expect(after.payment.capture?.cancelReason).toBe(reason);
        expect(after.bookingStatus).toBe(BookingStatus.CANCELLED);
        expect(after.status).toBe(OrderStatus.LINK_GENERATED);
        expect(await auditsOf(linked.id, AuditAction.AUTHORIZATION_RELEASED)).toHaveLength(1);
        expect(await auditsOf(linked.id, AuditAction.PAYMENT_SESSION_SUPERSEDED)).toHaveLength(0);
      },
    );

    it.each([
      { stripeSays: "another intent", current: "pi_test_current_session_intent" },
      { stripeSays: "no intent yet", current: null },
    ] as const)(
      "the SAME event is superseded when Stripe says the current session holds $stripeSays — Stripe's answer decides: the order untouched, PAYMENT_SESSION_SUPERSEDED naming what the session holds; a replay is a duplicate",
      async ({ current }) => {
        const linked = await linkedOrder();
        const { session, intentId } = await withoutRecordedIntent(linked.id);
        session.payment_intent = current;
        const before = await reload(linked.id);
        const retrieve = vi.spyOn(stripeSessions(), "retrieve");
        const event = intentCanceled(linked, intentId, "automatic");

        expect(await deliver(event)).toEqual({
          received: true,
          handled: true,
          duplicate: false,
          orderId: linked.id,
          reason: "superseded_payment_intent",
        });

        expect(retrieve).toHaveBeenCalledTimes(1);
        expect(retrieve).toHaveBeenCalledWith(session.id);
        const after = await reload(linked.id);
        expect(after.payment).toEqual(before.payment);
        expect(after.bookingStatus).toBe(before.bookingStatus);
        const superseded = await auditsOf(linked.id, AuditAction.PAYMENT_SESSION_SUPERSEDED);
        expect(superseded).toHaveLength(1);
        expect(superseded[0]!.metadata).toMatchObject({
          eventId: event.id,
          paymentIntentId: intentId,
          currentPaymentIntentId: current,
          currentSessionId: session.id,
        });
        expect(await auditsOf(linked.id, AuditAction.AUTHORIZATION_RELEASED)).toHaveLength(0);

        expect(await deliver(event)).toMatchObject({ handled: true, duplicate: true });
        expect(await auditsOf(linked.id, AuditAction.PAYMENT_SESSION_SUPERSEDED)).toHaveLength(1);
        expect((await reload(linked.id)).payment).toEqual(before.payment);
      },
    );

    it("a session lookup that fails answers 500 and claims and changes nothing — Stripe's retry of the same event is then decided on the session's answer", async () => {
      const linked = await linkedOrder();
      const { intentId } = await withoutRecordedIntent(linked.id);
      const before = await reload(linked.id);
      const event = intentCanceled(linked, intentId, "abandoned");
      vi.spyOn(stripeSessions(), "retrieve").mockRejectedValueOnce(
        new Error("Stripe API unreachable"),
      );

      const refused = await post(event);
      expect(refused.status).toBe(500);
      const untouched = await reload(linked.id);
      expect(untouched.payment).toEqual(before.payment);
      expect(untouched.bookingStatus).toBe(before.bookingStatus);
      expect(await auditsOf(linked.id, AuditAction.AUTHORIZATION_RELEASED)).toHaveLength(0);
      expect(await auditsOf(linked.id, AuditAction.PAYMENT_SESSION_SUPERSEDED)).toHaveLength(0);

      expect(await deliver(event)).toEqual({
        received: true,
        handled: true,
        duplicate: false,
        orderId: linked.id,
      });
      const released = await reload(linked.id);
      expect(released.payment.capture?.status).toBe(PaymentCaptureStatus.CANCELLED);
      expect(released.bookingStatus).toBe(BookingStatus.CANCELLED);
    });

    it("a regeneration that commits while Stripe is being asked keeps its new link — the write is pinned to the session the check asked about, the one thing that tells two links without an intent apart", async () => {
      const linked = await linkedOrder();
      const { session, intentId } = await withoutRecordedIntent(linked.id);
      const sessions = stripeSessions();
      const realRetrieve = sessions.retrieve.bind(sessions) as (id: string) => Promise<unknown>;
      let raced = false;
      let relinked: OrderDTO | undefined;
      vi.spyOn(sessions, "retrieve").mockImplementation((async (id: string) => {
        const answer = await realRetrieve(id);
        if (id === session.id && !raced) {
          raced = true;
          await inRequestOf("operator", async () => {
            ({ order: relinked } = await regeneratePaymentLink(linked.id, { actor: admin }));
          });
          // As production stores the new link: no intent, exactly like the
          // record the check read — only the session differs.
          await withoutRecordedIntent(linked.id);
        }
        return answer;
      }) as never);

      expect(await deliver(intentCanceled(linked, intentId, "abandoned"))).toMatchObject({
        handled: true,
      });
      expect(raced).toBe(true);
      // Stripe confirmed the event's intent for the session the handler read,
      // so the check passed; only the write's pin kept the new link.
      expect(await auditsOf(linked.id, AuditAction.PAYMENT_SESSION_SUPERSEDED)).toHaveLength(0);

      const after = await reload(linked.id);
      expect(after.payment.stripeSessionId).toBe(relinked!.payment.paymentSessionId);
      expect(after.payment.stripeSessionId).not.toBe(session.id);
      expect(after.payment.paymentIntentId).toBeNull();
      expect(after.payment.capture).toMatchObject({
        status: PaymentCaptureStatus.PENDING_AUTHORIZATION,
        cancelledAt: null,
        cancelReason: null,
      });
      expect(after.bookingStatus).toBe(BookingStatus.PENDING);
      expect(after.status).toBe(OrderStatus.PAYMENT_PENDING);
      expect(await auditsOf(linked.id, AuditAction.AUTHORIZATION_RELEASED)).toHaveLength(0);
    });
  });

  describe("the case that motivated it: a card declined on link A, a new link B, then Stripe cancels A's intent", () => {
    it.each(["abandoned", "automatic"] as const)(
      "cancellation_reason '%s': B's hold stays PENDING_AUTHORIZATION, the customer's authorization of B lands (AUTHORIZED, PAYMENT_AUTHORIZED email queued) and the operator captures it",
      async (cancellationReason) => {
        const linked = await linkedOrder();
        const { session: sessionA, intentId: intentA } = await withoutRecordedIntent(linked.id);
        expect(await deliver(declinedAtCheckout(linked, intentA))).toMatchObject({
          handled: true,
          duplicate: false,
        });
        const failed = await reload(linked.id);
        expect(failed.status).toBe(OrderStatus.FAILED);

        await regeneratePaymentLink(linked.id, { actor: admin });
        // Retiring A at Stripe is what makes Stripe cancel A's intent.
        expect(getCurrentTestStripe().sessionsExpired).toEqual([sessionA.id]);
        const { session: sessionB, intentId: intentB } = await withoutRecordedIntent(linked.id);
        // The customer has not opened link B yet.
        sessionB.payment_intent = null;
        const relinked = await reload(linked.id);
        expect(relinked.status).toBe(OrderStatus.PAYMENT_PENDING);
        expect(relinked.payment.capture?.status).toBe(PaymentCaptureStatus.PENDING_AUTHORIZATION);

        const retrieve = vi.spyOn(stripeSessions(), "retrieve");
        expect(await deliver(intentCanceled(linked, intentA, cancellationReason))).toEqual({
          received: true,
          handled: true,
          duplicate: false,
          orderId: linked.id,
          reason: "superseded_payment_intent",
        });
        expect(retrieve).toHaveBeenCalledWith(sessionB.id);
        const afterCancel = await reload(linked.id);
        expect(afterCancel.payment).toEqual(relinked.payment);
        expect(afterCancel.bookingStatus).toBe(BookingStatus.PENDING);
        expect(afterCancel.status).toBe(OrderStatus.PAYMENT_PENDING);
        const superseded = await auditsOf(linked.id, AuditAction.PAYMENT_SESSION_SUPERSEDED);
        expect(superseded.map(meta)).toEqual([
          expect.objectContaining({
            paymentIntentId: intentA,
            currentPaymentIntentId: null,
            currentSessionId: sessionB.id,
          }),
        ]);
        expect(await auditsOf(linked.id, AuditAction.AUTHORIZATION_RELEASED)).toHaveLength(0);

        Object.assign(sessionB, {
          payment_intent: intentB,
          status: "complete",
          payment_status: "unpaid",
        });
        const held = await authorize(linked.id, intentB);
        expect(held.payment.paymentIntentId).toBe(intentB);
        expect(await emailsQueued(linked.id, EmailKind.PAYMENT_AUTHORIZED)).toBe(1);

        await capturePayment(linked.id, { actor: admin });
        const captured = await reload(linked.id);
        expect(captured.status).toBe(OrderStatus.PAID);
        expect(captured.payment.capture?.status).toBe(PaymentCaptureStatus.CAPTURED);
        expect(captured.bookingStatus).toBe(BookingStatus.CONFIRMED);
        expect(getCurrentTestStripe().capturesRequested.map((c) => c.id)).toEqual([intentB]);
        expect(await emailsQueued(linked.id, EmailKind.PAYMENT_CONFIRMATION)).toBe(1);
      },
    );
  });
});

describe("2 · payment_intent.payment_failed while the hold still stands is a declined capture, never a failed order", () => {
  it("on an AUTHORIZED hold: CAPTURE_FAILED, the order NOT failed — and the event is claimed, so Stripe's retry of it (which finds CAPTURE_FAILED) is a duplicate that records nothing more", async () => {
    const linked = await linkedOrder();
    const held = await authorize(linked.id);
    const decline = buildPaymentIntentFailed({
      paymentIntentId: held.payment.paymentIntentId!,
      message: INSUFFICIENT_FUNDS,
    });

    expect(await deliver(decline)).toEqual({
      received: true,
      handled: true,
      duplicate: false,
      orderId: linked.id,
    });
    const declined = await reload(linked.id);
    expect(declined.status).toBe(OrderStatus.LINK_GENERATED);
    expect(declined.payment.capture?.status).toBe(PaymentCaptureStatus.CAPTURE_FAILED);

    expect(await deliver(decline)).toMatchObject({ handled: true, duplicate: true });
    const rows = await auditsOf(linked.id, AuditAction.PAYMENT_CAPTURE_FAILED);
    expect(rows.map((row) => meta(row).eventId)).toEqual([decline.id]);
    expect(
      await evidenceOf(linked.id, OrderEvidenceEventType.PAYMENT_CAPTURE_FAILED, decline.id),
    ).toBe(1);
    expect((await reload(linked.id)).payment).toEqual(declined.payment);
    expect(await auditsOf(linked.id, AuditAction.PAYMENT_FAILED)).toHaveLength(0);
  });

  it("on a CAPTURE_FAILED hold (the operator's own declined attempt wrote it first): CAPTURE_FAILED with Stripe's reason, the order NOT failed, exactly one PAYMENT_CAPTURE_FAILED audit row and evidence entry for the event; a replay adds nothing; Retry capture then takes the money", async () => {
    const linked = await linkedOrder();
    const held = await authorize(linked.id);
    const failedAttempt = await declinedCapture(linked.id, CARD_DECLINED);
    expect(failedAttempt.payment.capture?.lastError).toBe(CARD_DECLINED);

    const decline = buildPaymentIntentFailed({
      paymentIntentId: held.payment.paymentIntentId!,
      message: INSUFFICIENT_FUNDS,
    });
    expect(await deliver(decline)).toEqual({
      received: true,
      handled: true,
      duplicate: false,
      orderId: linked.id,
    });

    const after = await reload(linked.id);
    expect(after.status).toBe(OrderStatus.LINK_GENERATED);
    expect(after.payment.status).toBe(OrderStatus.LINK_GENERATED);
    expect(after.payment.failureReason ?? null).toBeNull();
    expect(after.payment.capture?.status).toBe(PaymentCaptureStatus.CAPTURE_FAILED);
    expect(after.payment.capture?.lastError).toBe(INSUFFICIENT_FUNDS);
    expect(after.bookingStatus).toBe(BookingStatus.PENDING);
    const rows = await auditsOf(linked.id, AuditAction.PAYMENT_CAPTURE_FAILED);
    // Stripe's event, and the operator's own declined attempt before it.
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => meta(row).eventId === decline.id)).toHaveLength(1);
    expect(
      await evidenceOf(linked.id, OrderEvidenceEventType.PAYMENT_CAPTURE_FAILED, decline.id),
    ).toBe(1);
    expect(await auditsOf(linked.id, AuditAction.PAYMENT_FAILED)).toHaveLength(0);

    expect(await deliver(decline)).toMatchObject({ handled: true, duplicate: true });
    expect(await auditsOf(linked.id, AuditAction.PAYMENT_CAPTURE_FAILED)).toHaveLength(2);
    expect(
      await evidenceOf(linked.id, OrderEvidenceEventType.PAYMENT_CAPTURE_FAILED, decline.id),
    ).toBe(1);
    const replayed = await reload(linked.id);
    expect(replayed.payment).toEqual(after.payment);
    expect(replayed.status).toBe(after.status);

    await capturePayment(linked.id, { actor: admin });
    const paid = await reload(linked.id);
    expect(paid.status).toBe(OrderStatus.PAID);
    expect(paid.payment.capture?.status).toBe(PaymentCaptureStatus.CAPTURED);
  });

  it("on a CAPTURE_PENDING hold (Stripe's event lands while the operator's capture call is still in flight): CAPTURE_FAILED with the decline, the order NOT failed, one audit row for the event", async () => {
    const linked = await linkedOrder();
    const held = await authorize(linked.id);
    const decline = buildPaymentIntentFailed({
      paymentIntentId: held.payment.paymentIntentId!,
      message: INSUFFICIENT_FUNDS,
    });
    let midCapture: WebhookReply | undefined;
    vi.spyOn(stripeIntents(), "capture").mockImplementationOnce((async () => {
      expect((await reload(linked.id)).payment.capture?.status).toBe(
        PaymentCaptureStatus.CAPTURE_PENDING,
      );
      midCapture = await deliver(decline);
      throw Object.assign(new Error(CARD_DECLINED), { code: "card_declined" });
    }) as never);

    await expect(capturePayment(linked.id, { actor: admin })).rejects.toBeInstanceOf(PaymentError);

    expect(midCapture).toEqual({
      received: true,
      handled: true,
      duplicate: false,
      orderId: linked.id,
    });
    const after = await reload(linked.id);
    expect(after.status).toBe(OrderStatus.LINK_GENERATED);
    expect(after.payment.status).toBe(OrderStatus.LINK_GENERATED);
    expect(after.payment.failureReason ?? null).toBeNull();
    expect(after.payment.capture?.status).toBe(PaymentCaptureStatus.CAPTURE_FAILED);
    const rows = await auditsOf(linked.id, AuditAction.PAYMENT_CAPTURE_FAILED);
    const fromStripe = rows.filter((row) => meta(row).eventId === decline.id);
    expect(fromStripe).toHaveLength(1);
    expect(meta(fromStripe[0]).reason).toBe(INSUFFICIENT_FUNDS);
    expect(
      await evidenceOf(linked.id, OrderEvidenceEventType.PAYMENT_CAPTURE_FAILED, decline.id),
    ).toBe(1);
    expect(await auditsOf(linked.id, AuditAction.PAYMENT_FAILED)).toHaveLength(0);

    // Stripe's retry finds the hold CAPTURE_FAILED; only the claim made
    // mid-capture keeps it from being recorded a second time.
    expect(await deliver(decline)).toMatchObject({ handled: true, duplicate: true });
    const afterRetry = await auditsOf(linked.id, AuditAction.PAYMENT_CAPTURE_FAILED);
    expect(afterRetry.filter((row) => meta(row).eventId === decline.id)).toHaveLength(1);
    expect(
      await evidenceOf(linked.id, OrderEvidenceEventType.PAYMENT_CAPTURE_FAILED, decline.id),
    ).toBe(1);
  });

  it("a decline whose write would land after the operator's Retry capture took the money records nothing: no audit row, no evidence — the capture stays CAPTURED and the order PAID", async () => {
    const linked = await linkedOrder();
    const held = await authorize(linked.id);
    await declinedCapture(linked.id, CARD_DECLINED);
    expect(await auditsOf(linked.id, AuditAction.PAYMENT_CAPTURE_FAILED)).toHaveLength(1);

    // The handler has read the order (CAPTURE_FAILED) and is about to write
    // when the operator's retry lands.
    const realUpdateOne = Order.updateOne.bind(Order) as (...args: unknown[]) => unknown;
    let raced = false;
    vi.spyOn(Order, "updateOne").mockImplementation(((
      filter: unknown,
      update: { $set?: Record<string, unknown> } | undefined,
      ...rest: unknown[]
    ) => {
      if (
        !raced &&
        update?.$set?.["payment.capture.status"] === PaymentCaptureStatus.CAPTURE_FAILED
      ) {
        raced = true;
        return inRequestOf("operator", () => capturePayment(linked.id, { actor: admin })).then(
          () => realUpdateOne(filter, update, ...rest),
        );
      }
      return realUpdateOne(filter, update, ...rest);
    }) as never);

    const decline = buildPaymentIntentFailed({
      paymentIntentId: held.payment.paymentIntentId!,
      message: CARD_DECLINED,
    });
    expect(await deliver(decline)).toMatchObject({ handled: true });
    expect(raced).toBe(true);

    const after = await reload(linked.id);
    expect(after.status).toBe(OrderStatus.PAID);
    expect(after.payment.capture?.status).toBe(PaymentCaptureStatus.CAPTURED);
    expect(after.payment.capture?.lastError ?? null).toBeNull();
    const rows = await auditsOf(linked.id, AuditAction.PAYMENT_CAPTURE_FAILED);
    expect(rows).toHaveLength(1);
    expect(rows.some((row) => meta(row).eventId === decline.id)).toBe(false);
    expect(
      await evidenceOf(linked.id, OrderEvidenceEventType.PAYMENT_CAPTURE_FAILED, decline.id),
    ).toBe(0);
  });

  it("a decline whose write would land after the operator released the hold records nothing: the hold stays CANCELLED — not resurrected as a failed capture — with no audit row or evidence, so a new link can still be issued", async () => {
    const linked = await linkedOrder();
    const held = await authorize(linked.id);
    await declinedCapture(linked.id, CARD_DECLINED);

    // The handler has read the order (CAPTURE_FAILED) and is about to write
    // when the operator's release lands.
    const realUpdateOne = Order.updateOne.bind(Order) as (...args: unknown[]) => unknown;
    let raced = false;
    let released: Awaited<ReturnType<typeof reload>> | undefined;
    vi.spyOn(Order, "updateOne").mockImplementation(((
      filter: unknown,
      update: { $set?: Record<string, unknown> } | undefined,
      ...rest: unknown[]
    ) => {
      if (
        !raced &&
        update?.$set?.["payment.capture.status"] === PaymentCaptureStatus.CAPTURE_FAILED
      ) {
        raced = true;
        return inRequestOf("operator", () =>
          cancelAuthorization(linked.id, { actor: admin }, { reason: "Supplier could not confirm" }),
        )
          .then(async () => {
            released = await reload(linked.id);
          })
          .then(() => realUpdateOne(filter, update, ...rest));
      }
      return realUpdateOne(filter, update, ...rest);
    }) as never);

    const decline = buildPaymentIntentFailed({
      paymentIntentId: held.payment.paymentIntentId!,
      message: INSUFFICIENT_FUNDS,
    });
    expect(await deliver(decline)).toMatchObject({ handled: true });
    expect(raced).toBe(true);

    const after = await reload(linked.id);
    expect(after.payment).toEqual(released!.payment);
    expect(after.payment.capture).toMatchObject({
      status: PaymentCaptureStatus.CANCELLED,
      cancelReason: "Supplier could not confirm",
    });
    expect(after.status).toBe(OrderStatus.LINK_GENERATED);
    expect(after.bookingStatus).toBe(BookingStatus.CANCELLED);
    const rows = await auditsOf(linked.id, AuditAction.PAYMENT_CAPTURE_FAILED);
    expect(rows.some((row) => meta(row).eventId === decline.id)).toBe(false);
    expect(
      await evidenceOf(linked.id, OrderEvidenceEventType.PAYMENT_CAPTURE_FAILED, decline.id),
    ).toBe(0);

    const { order: relinked } = await regeneratePaymentLink(linked.id, { actor: admin });
    expect(relinked.payment.capture?.status).toBe(PaymentCaptureStatus.PENDING_AUTHORIZATION);
  });

  it("a decline Stripe reports after the capture completed changes nothing: still PAID and CAPTURED, no audit row, no evidence", async () => {
    const linked = await linkedOrder();
    const held = await authorize(linked.id);
    await capturePayment(linked.id, { actor: admin });
    const captured = await reload(linked.id);
    expect(captured.payment.capture?.status).toBe(PaymentCaptureStatus.CAPTURED);

    await deliver(
      buildPaymentIntentFailed({
        paymentIntentId: held.payment.paymentIntentId!,
        message: CARD_DECLINED,
      }),
    );

    const after = await reload(linked.id);
    expect(after.status).toBe(OrderStatus.PAID);
    expect(after.payment).toEqual(captured.payment);
    expect(await auditsOf(linked.id, AuditAction.PAYMENT_CAPTURE_FAILED)).toHaveLength(0);
    expect(await auditsOf(linked.id, AuditAction.PAYMENT_FAILED)).toHaveLength(0);
    expect(await evidenceOf(linked.id, OrderEvidenceEventType.PAYMENT_CAPTURE_FAILED)).toBe(0);
  });
});

describe("3 · an operator's release records CANCELLED only on the hold it voided", () => {
  it("Stripe's notice of the release is processed and a new link issued between Stripe's cancel and the release's own write: the new link's re-armed hold is left untouched — and is then authorized and captured", async () => {
    const linked = await linkedOrder();
    const held = await authorize(linked.id);
    const voided = held.payment.paymentIntentId!;
    const intents = stripeIntents();
    const realCancel = intents.cancel.bind(intents) as (...args: unknown[]) => Promise<unknown>;
    let relinked: { sessionId: string; intentId: string } | undefined;
    vi.spyOn(intents, "cancel").mockImplementationOnce((async (...args: unknown[]) => {
      const answer = await realCancel(...args);
      expect(await deliver(intentCanceled(linked, voided, "abandoned"))).toMatchObject({
        handled: true,
        duplicate: false,
      });
      await regeneratePaymentLink(linked.id, { actor: admin });
      // As production stores the new link: no intent until the customer pays.
      const { session, intentId } = await withoutRecordedIntent(linked.id);
      relinked = { sessionId: session.id, intentId };
      return answer;
    }) as never);

    await cancelAuthorization(linked.id, { actor: admin }, { reason: "Supplier could not confirm" });
    expect(relinked).toBeDefined();

    const after = await reload(linked.id);
    expect(after.payment.stripeSessionId).toBe(relinked!.sessionId);
    expect(after.payment.paymentIntentId).toBeNull();
    expect(after.payment.capture).toMatchObject({
      method: CaptureMode.MANUAL,
      status: PaymentCaptureStatus.PENDING_AUTHORIZATION,
      cancelledAt: null,
      cancelReason: null,
    });
    expect(after.bookingStatus).toBe(BookingStatus.PENDING);
    expect(after.status).toBe(OrderStatus.PAYMENT_PENDING);
    expect(getCurrentTestStripe().cancelsRequested.map((c) => c.id)).toEqual([voided]);

    await authorize(linked.id, relinked!.intentId);
    await capturePayment(linked.id, { actor: admin });
    const captured = await reload(linked.id);
    expect(captured.status).toBe(OrderStatus.PAID);
    expect(captured.payment.capture?.status).toBe(PaymentCaptureStatus.CAPTURED);
    expect(getCurrentTestStripe().capturesRequested.map((c) => c.id)).toEqual([
      relinked!.intentId,
    ]);
  });
});

describe("4 · a link is never regenerated over a CAPTURE_FAILED hold — the declined capture left the hold standing", () => {
  it("on a CAPTURE_FAILED order: 409 'This order has a live authorization…', the order unchanged, no Stripe session created or retired", async () => {
    const linked = await linkedOrder();
    await authorize(linked.id);
    const before = await declinedCapture(linked.id);
    const links = await linksRecorded(linked.id);
    const stub = getCurrentTestStripe();

    const res = await regenerate(linked.id);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      ok: false,
      error: { code: "CONFLICT", message: LIVE_AUTHORIZATION },
    });
    const after = await reload(linked.id);
    expect(after.payment).toEqual(before.payment);
    expect(after.status).toBe(before.status);
    expect(after.bookingStatus).toBe(before.bookingStatus);
    expect(stub.sessionsCreated).toHaveLength(1);
    expect(stub.sessionsExpired).toEqual([]);
    expect(await linksRecorded(linked.id)).toBe(links);
  });

  it("an order that turns CAPTURE_FAILED while the regeneration asks Stripe about its current session (the customer authorized, the operator's capture was declined) is refused after that check: 409 '…already completed checkout…', no new Stripe session", async () => {
    const linked = await linkedOrder();
    const original = await reload(linked.id);
    const links = await linksRecorded(linked.id);
    const session = await stripeSessionOf(linked.id);
    const sessions = stripeSessions();
    const realRetrieve = sessions.retrieve.bind(sessions) as (id: string) => Promise<unknown>;
    let raced = false;
    vi.spyOn(sessions, "retrieve").mockImplementation((async (id: string) => {
      if (id === session.id && !raced) {
        raced = true;
        await authorize(linked.id);
        await declinedCapture(linked.id);
        Object.assign(session, { status: "complete", payment_status: "unpaid" });
      }
      return realRetrieve(id);
    }) as never);

    const res = await regenerate(linked.id);

    expect(raced).toBe(true);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      ok: false,
      error: { code: "CONFLICT", message: CHECKOUT_ALREADY_COMPLETED },
    });
    const stub = getCurrentTestStripe();
    expect(stub.sessionsCreated).toHaveLength(1);
    expect(stub.sessionsExpired).toEqual([]);
    const after = await reload(linked.id);
    expect(after.payment.capture?.status).toBe(PaymentCaptureStatus.CAPTURE_FAILED);
    expect(after.payment.stripeSessionId).toBe(original.payment.stripeSessionId);
    expect(after.payment.paymentIntentId).toBe(original.payment.paymentIntentId);
    expect(await linksRecorded(linked.id)).toBe(links);
  });

  it("an order that turns CAPTURE_FAILED while the replacement session is being created is refused at the write: 409 '…changed while its payment link was being regenerated…', the hold keeps its session and intent, and the old link is not retired", async () => {
    const linked = await linkedOrder();
    const original = await reload(linked.id);
    const links = await linksRecorded(linked.id);
    const sessions = stripeSessions();
    const realCreate = sessions.create.bind(sessions) as (...args: unknown[]) => Promise<unknown>;
    let raced = false;
    vi.spyOn(sessions, "create").mockImplementationOnce((async (...args: unknown[]) => {
      raced = true;
      await authorize(linked.id);
      await declinedCapture(linked.id);
      return realCreate(...args);
    }) as never);

    const res = await regenerate(linked.id);

    expect(raced).toBe(true);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      ok: false,
      error: { code: "CONFLICT", message: CHANGED_WHILE_REGENERATING },
    });
    const after = await reload(linked.id);
    expect(after.payment.capture?.status).toBe(PaymentCaptureStatus.CAPTURE_FAILED);
    expect(after.payment.stripeSessionId).toBe(original.payment.stripeSessionId);
    expect(after.payment.paymentIntentId).toBe(original.payment.paymentIntentId);
    expect(getCurrentTestStripe().sessionsExpired).toEqual([]);
    expect(await linksRecorded(linked.id)).toBe(links);
  });
});

describe("5 · the payment request is not re-sent once a manual-capture order is past its checkout", () => {
  it.each([
    {
      capture: PaymentCaptureStatus.AUTHORIZED,
      message: ALREADY_AUTHORIZED,
      reach: async (order: OrderDTO) => {
        await authorize(order.id);
      },
    },
    {
      capture: PaymentCaptureStatus.CAPTURE_FAILED,
      message: ALREADY_AUTHORIZED,
      reach: async (order: OrderDTO) => {
        await authorize(order.id);
        await declinedCapture(order.id);
      },
    },
    {
      capture: PaymentCaptureStatus.CANCELLED,
      message: HOLD_RELEASED,
      reach: async (order: OrderDTO) => {
        await authorize(order.id);
        await cancelAuthorization(order.id, { actor: admin }, { reason: "Supplier could not confirm" });
      },
    },
    {
      capture: PaymentCaptureStatus.AUTHORIZATION_EXPIRED,
      message: HOLD_RELEASED,
      reach: async (order: OrderDTO) => {
        const held = await authorize(order.id);
        await deliver(intentCanceled(order, held.payment.paymentIntentId!, "automatic"));
      },
    },
  ])(
    "$capture → 409 telling the operator what to do instead; no email leaves and the order is unchanged",
    async ({ capture, message, reach }) => {
      const linked = await linkedOrder();
      expect((await sendRequest(linked.id)).status).toBe(200);
      await reach(linked);
      const before = await reload(linked.id);
      expect(before.payment.capture?.status).toBe(capture);

      const resend = await sendRequest(linked.id);

      expect(resend.status).toBe(409);
      expect(resend.body).toMatchObject({ ok: false, error: { code: "CONFLICT", message } });
      expect(resend.emails).toHaveLength(0);
      const after = await reload(linked.id);
      expect(after.status).toBe(before.status);
      expect(after.payment).toEqual(before.payment);
    },
  );

  it("CAPTURE_PENDING (the operator's capture still in flight) → 409 'already authorized'; no email leaves", async () => {
    const linked = await linkedOrder();
    expect((await sendRequest(linked.id)).status).toBe(200);
    await authorize(linked.id);
    const intents = stripeIntents();
    const realCapture = intents.capture.bind(intents) as (...args: unknown[]) => Promise<unknown>;
    let midCapture: Awaited<ReturnType<typeof sendRequest>> | undefined;
    vi.spyOn(intents, "capture").mockImplementationOnce((async (...args: unknown[]) => {
      expect((await reload(linked.id)).payment.capture?.status).toBe(
        PaymentCaptureStatus.CAPTURE_PENDING,
      );
      midCapture = await sendRequest(linked.id);
      return realCapture(...args);
    }) as never);

    await capturePayment(linked.id, { actor: admin });

    expect(midCapture?.status).toBe(409);
    expect(midCapture?.body).toMatchObject({
      ok: false,
      error: { code: "CONFLICT", message: ALREADY_AUTHORIZED },
    });
    expect(midCapture?.emails).toHaveLength(0);
    expect((await reload(linked.id)).status).toBe(OrderStatus.PAID);
  });

  it.each([
    {
      order: "a manual-capture order the customer has not authorized yet (PENDING_AUTHORIZATION)",
      mode: CaptureMode.MANUAL,
      capture: PaymentCaptureStatus.PENDING_AUTHORIZATION,
    },
    {
      order: "an automatic-capture order (no capture record)",
      mode: CaptureMode.AUTOMATIC,
      capture: null,
    },
  ])("still sends — and re-sends — for $order", async ({ mode, capture }) => {
    await setRentalMode(mode);
    const linked = await linkedOrder();
    expect((await reload(linked.id)).payment.capture?.status ?? null).toBe(capture);

    const first = await sendRequest(linked.id);
    expect(first.status).toBe(200);
    expect(first.emails).toHaveLength(1);
    expect(first.emails[0]!.to).toBe(CUSTOMER_EMAIL);
    expect((await reload(linked.id)).status).toBe(OrderStatus.PAYMENT_PENDING);

    const again = await sendRequest(linked.id);
    expect(again.status).toBe(200);
    expect(again.emails).toHaveLength(1);
    const after = await reload(linked.id);
    expect(after.status).toBe(OrderStatus.PAYMENT_PENDING);
    expect(after.payment.capture?.status ?? null).toBe(capture);
  });
});

describe("6 · payment_intent.payment_failed for a link a manual-capture order has since replaced is history; an automatic-capture order handles its declines exactly as before", () => {
  const modes = [CaptureMode.MANUAL, CaptureMode.AUTOMATIC];
  /** What a fresh link leaves on the order: a re-armed hold on manual
   *  capture, no capture record at all on automatic. */
  const freshCapture = (mode: CaptureMode) =>
    mode === CaptureMode.MANUAL ? PaymentCaptureStatus.PENDING_AUTHORIZATION : null;

  it.each(
    [CaptureMode.MANUAL].flatMap((mode) =>
      (["recorded", "unopened", "opened"] as const).map((shape) => ({
        mode,
        shape,
        when: INTENT_SHAPES[shape],
      })),
    ),
  )(
    "$mode — Stripe's retry of link A's decline lands after link B was issued, and $when: reply 'superseded_payment_intent', the order untouched (PAYMENT_PENDING, nothing failed), ONE PAYMENT_SESSION_SUPERSEDED audit naming both intents and link B; a replay is a duplicate; the payment request still goes out",
    async ({ mode, shape }) => {
      await setRentalMode(mode);
      const { linked, intentA, sessionB, intentB, relinked } = await replacedLink(shape);
      expect(relinked.payment.capture?.status ?? null).toBe(freshCapture(mode));
      const retrieve = vi.spyOn(stripeSessions(), "retrieve");
      const decline = declinedAtCheckout(linked, intentA);

      expect(await deliver(decline)).toEqual({
        received: true,
        handled: true,
        duplicate: false,
        orderId: linked.id,
        reason: "superseded_payment_intent",
      });

      if (shape === "recorded") {
        expect(retrieve).not.toHaveBeenCalled();
      } else {
        expect(retrieve).toHaveBeenCalledTimes(1);
        expect(retrieve).toHaveBeenCalledWith(sessionB.id);
      }
      const after = await reload(linked.id);
      expect(after.payment).toEqual(relinked.payment);
      expect(after.status).toBe(OrderStatus.PAYMENT_PENDING);
      expect(after.payment.status).toBe(OrderStatus.PAYMENT_PENDING);
      expect(after.payment.failureReason ?? null).toBeNull();
      expect(after.bookingStatus).toBe(relinked.bookingStatus);
      const superseded = await auditsOf(linked.id, AuditAction.PAYMENT_SESSION_SUPERSEDED);
      expect(superseded).toHaveLength(1);
      expect(String(superseded[0]!.organizationId)).toBe(String(rental));
      expect(superseded[0]!.metadata).toMatchObject({
        eventId: decline.id,
        type: "payment.failed",
        paymentIntentId: intentA,
        currentPaymentIntentId: shape === "unopened" ? null : intentB,
        currentSessionId: sessionB.id,
      });
      expect(await auditsOf(linked.id, AuditAction.PAYMENT_FAILED)).toHaveLength(0);
      expect(await evidenceOf(linked.id, OrderEvidenceEventType.PAYMENT_FAILED)).toBe(0);

      expect(await deliver(decline)).toMatchObject({ handled: true, duplicate: true });
      expect(await auditsOf(linked.id, AuditAction.PAYMENT_SESSION_SUPERSEDED)).toHaveLength(1);
      expect(await auditsOf(linked.id, AuditAction.PAYMENT_FAILED)).toHaveLength(0);
      expect((await reload(linked.id)).payment).toEqual(relinked.payment);

      // Link B is still the customer's to pay on.
      const request = await sendRequest(linked.id);
      expect(request.status, JSON.stringify(request.body)).toBe(200);
      expect(request.emails).toHaveLength(1);
      expect(request.emails[0]!.to).toBe(CUSTOMER_EMAIL);
      const requested = await reload(linked.id);
      expect(requested.status).toBe(OrderStatus.PAYMENT_PENDING);
      expect(requested.payment.capture?.status ?? null).toBe(freshCapture(mode));
    },
  );

  it.each(
    modes.flatMap((mode) =>
      (["recorded", "opened"] as const).map((shape) => ({
        mode,
        shape,
        when: INTENT_SHAPES[shape],
      })),
    ),
  )(
    "$mode — $when: a decline for link B's OWN intent still fails the order as before — FAILED with the decline, the capture record untouched, ONE PAYMENT_FAILED audit row and evidence entry, nothing superseded; a replay is a duplicate; a failed order takes no request",
    async ({ mode, shape }) => {
      await setRentalMode(mode);
      const { linked, sessionB, intentB, relinked } = await replacedLink(shape);
      const retrieve = vi.spyOn(stripeSessions(), "retrieve");
      const decline = declinedAtCheckout(linked, intentB);

      expect(await deliver(decline)).toEqual({
        received: true,
        handled: true,
        duplicate: false,
        orderId: linked.id,
      });

      // An automatic-capture order is never asked about: its declines are
      // handled exactly as before.
      if (shape === "recorded" || mode === CaptureMode.AUTOMATIC) {
        expect(retrieve).not.toHaveBeenCalled();
      } else {
        expect(retrieve).toHaveBeenCalledWith(sessionB.id);
      }
      const failed = await reload(linked.id);
      expect(failed.status).toBe(OrderStatus.FAILED);
      expect(failed.payment.status).toBe(OrderStatus.FAILED);
      expect(failed.payment.failureReason).toBe(CARD_DECLINED);
      expect(failed.payment.stripeSessionId).toBe(sessionB.id);
      expect(failed.payment.capture ?? null).toEqual(relinked.payment.capture ?? null);
      expect(failed.payment.capture?.status ?? null).toBe(freshCapture(mode));
      const rows = await auditsOf(linked.id, AuditAction.PAYMENT_FAILED);
      expect(rows.map(meta)).toEqual([
        expect.objectContaining({ reason: CARD_DECLINED, eventId: decline.id }),
      ]);
      expect(
        await evidenceOf(linked.id, OrderEvidenceEventType.PAYMENT_FAILED, decline.id),
      ).toBe(1);
      expect(await auditsOf(linked.id, AuditAction.PAYMENT_SESSION_SUPERSEDED)).toHaveLength(0);

      expect(await deliver(decline)).toMatchObject({ handled: true, duplicate: true });
      expect(await auditsOf(linked.id, AuditAction.PAYMENT_FAILED)).toHaveLength(1);

      const request = await sendRequest(linked.id);
      expect(request.status).toBe(409);
      expect(request.body).toMatchObject({
        ok: false,
        error: { code: "CONFLICT", message: ORDER_FAILED },
      });
      expect(request.emails).toHaveLength(0);
    },
  );

  it.each(
    (["recorded", "unopened", "opened"] as const).map((shape) => ({
      shape,
      when: INTENT_SHAPES[shape],
    })),
  )(
    "AUTOMATIC — $when: Stripe's retry of link A's decline after link B was issued is handled exactly as before this change — the order FAILED with the decline, no session lookup, nothing recorded as superseded (automatic-capture decline handling is out of scope)",
    async ({ shape }) => {
      await setRentalMode(CaptureMode.AUTOMATIC);
      const { linked, intentA } = await replacedLink(shape);
      const retrieve = vi.spyOn(stripeSessions(), "retrieve");
      const decline = declinedAtCheckout(linked, intentA);

      expect(await deliver(decline)).toEqual({
        received: true,
        handled: true,
        duplicate: false,
        orderId: linked.id,
      });
      expect(retrieve).not.toHaveBeenCalled();
      const after = await reload(linked.id);
      expect(after.status).toBe(OrderStatus.FAILED);
      expect(after.payment.failureReason).toBe(CARD_DECLINED);
      expect(after.payment.capture ?? null).toBeNull();
      expect(await auditsOf(linked.id, AuditAction.PAYMENT_SESSION_SUPERSEDED)).toHaveLength(0);
      expect(await auditsOf(linked.id, AuditAction.PAYMENT_FAILED)).toHaveLength(1);
    },
  );

  it("a session lookup that fails answers 500, claiming and changing nothing — the order is never failed on a guess; Stripe's retry of the same decline is then decided on the session's answer", async () => {
    const { linked, intentA, relinked } = await replacedLink("unopened");
    const decline = declinedAtCheckout(linked, intentA);
    vi.spyOn(stripeSessions(), "retrieve").mockRejectedValueOnce(
      new Error("Stripe API unreachable"),
    );

    const refused = await post(decline);
    expect(refused.status).toBe(500);
    expect(await reload(linked.id)).toEqual(relinked);
    expect(await ProcessedWebhookEvent.countDocuments({ gatewayEventId: decline.id })).toBe(0);
    expect(await auditsOf(linked.id, AuditAction.PAYMENT_FAILED)).toHaveLength(0);
    expect(await auditsOf(linked.id, AuditAction.PAYMENT_SESSION_SUPERSEDED)).toHaveLength(0);

    expect(await deliver(decline)).toEqual({
      received: true,
      handled: true,
      duplicate: false,
      orderId: linked.id,
      reason: "superseded_payment_intent",
    });
    const after = await reload(linked.id);
    expect(after.status).toBe(OrderStatus.PAYMENT_PENDING);
    expect(after.payment).toEqual(relinked.payment);
    expect(await auditsOf(linked.id, AuditAction.PAYMENT_FAILED)).toHaveLength(0);
  });
});

describe("7 · a card declined, then another authorized on the same open Checkout: the hold puts the order back in progress", () => {
  it.each([
    { order: "knows its intent", recorded: true, first: "payment_intent.amount_capturable_updated" },
    { order: "knows its intent", recorded: true, first: "checkout.session.completed" },
    {
      order: "knows no intent (production)",
      recorded: false,
      first: "payment_intent.amount_capturable_updated",
    },
    { order: "knows no intent (production)", recorded: false, first: "checkout.session.completed" },
  ] as const)(
    "the order $order, Stripe's $first first: the decline fails it (FAILED, its reason recorded); the authorization brings it back — AUTHORIZED, status and payment.status PAYMENT_PENDING, the failure cleared, ONE PAYMENT_AUTHORIZED email (Stripe's other notice is a duplicate) — and the operator captures it",
    async ({ recorded, first }) => {
      const linked = await linkedOrder();
      const session = await stripeSessionOf(linked.id);
      const intent = session.payment_intent!;
      if (!recorded) await withoutRecordedIntent(linked.id);
      const retrieve = vi.spyOn(stripeSessions(), "retrieve");

      // The first card is declined; Checkout keeps the session open.
      expect(await deliver(declinedAtCheckout(linked, intent))).toEqual({
        received: true,
        handled: true,
        duplicate: false,
        orderId: linked.id,
      });
      // Without a recorded intent, Stripe's answer for the session is what
      // makes this decline the current session's.
      if (recorded) {
        expect(retrieve).not.toHaveBeenCalled();
      } else {
        expect(retrieve).toHaveBeenCalledWith(session.id);
      }
      const failed = await reload(linked.id);
      expect(failed.status).toBe(OrderStatus.FAILED);
      expect(failed.payment.status).toBe(OrderStatus.FAILED);
      expect(failed.payment.failureReason).toBe(CARD_DECLINED);
      expect(failed.payment.capture?.status).toBe(PaymentCaptureStatus.PENDING_AUTHORIZATION);

      // The customer authorizes another card on the same session; Stripe
      // sends both of its notices for it.
      Object.assign(session, { status: "complete", payment_status: "unpaid" });
      const capturable = buildAmountCapturableUpdated({
        paymentIntentId: intent,
        orderId: linked.id,
        orderNumber: linked.orderNumber,
        amountCapturable: session.amount_total!,
      });
      const completed = checkoutCompleted(linked, session, intent, "unpaid");
      const [lead, follow] =
        first === "checkout.session.completed"
          ? [completed, capturable]
          : [capturable, completed];

      expect(await deliver(lead)).toEqual({
        received: true,
        handled: true,
        duplicate: false,
        orderId: linked.id,
      });

      const held = await reload(linked.id);
      expect(held.status).toBe(OrderStatus.PAYMENT_PENDING);
      expect(held.payment.status).toBe(OrderStatus.PAYMENT_PENDING);
      expect(held.payment.failureReason).toBeNull();
      expect(held.payment.paymentIntentId).toBe(intent);
      expect(held.payment.capture).toMatchObject({
        method: CaptureMode.MANUAL,
        status: PaymentCaptureStatus.AUTHORIZED,
        amountAuthorized: failed.pricing.amount,
      });
      expect(held.bookingStatus).toBe(BookingStatus.PENDING);
      expect(await emailsQueued(linked.id, EmailKind.PAYMENT_AUTHORIZED)).toBe(1);
      expect(await auditsOf(linked.id, AuditAction.PAYMENT_AUTHORIZED)).toHaveLength(1);

      expect(await deliver(follow)).toMatchObject({ handled: true, duplicate: true });
      expect(await reload(linked.id)).toEqual(held);
      expect(await emailsQueued(linked.id, EmailKind.PAYMENT_AUTHORIZED)).toBe(1);

      // An ordinary hold to the operator: nothing left to ask the customer
      // for (not "order is failed")…
      const request = await sendRequest(linked.id);
      expect(request.status).toBe(409);
      expect(request.body).toMatchObject({
        ok: false,
        error: { code: "CONFLICT", message: ALREADY_AUTHORIZED },
      });
      // …and Capture takes the money.
      await capturePayment(linked.id, { actor: admin });
      const captured = await reload(linked.id);
      expect(captured.status).toBe(OrderStatus.PAID);
      expect(captured.payment.capture?.status).toBe(PaymentCaptureStatus.CAPTURED);
      expect(captured.bookingStatus).toBe(BookingStatus.CONFIRMED);
      expect(getCurrentTestStripe().capturesRequested.map((c) => c.id)).toEqual([intent]);
      expect(await emailsQueued(linked.id, EmailKind.PAYMENT_CONFIRMATION)).toBe(1);
    },
  );

  it.each([
    { order: "knows its intent", recorded: true },
    { order: "knows no intent (production)", recorded: false },
  ])(
    "an automatic-capture order that $order, declined and then paid on the same session, ends PAID exactly as before: the failure cleared, the amount received, a receipt, no capture record and no authorization email",
    async ({ recorded }) => {
      await setRentalMode(CaptureMode.AUTOMATIC);
      const linked = await linkedOrder();
      const session = await stripeSessionOf(linked.id);
      const intent = session.payment_intent!;
      if (!recorded) await withoutRecordedIntent(linked.id);

      expect(await deliver(declinedAtCheckout(linked, intent))).toEqual({
        received: true,
        handled: true,
        duplicate: false,
        orderId: linked.id,
      });
      const failed = await reload(linked.id);
      expect(failed.status).toBe(OrderStatus.FAILED);
      expect(failed.payment.status).toBe(OrderStatus.FAILED);
      expect(failed.payment.failureReason).toBe(CARD_DECLINED);
      expect(failed.payment.capture ?? null).toBeNull();

      Object.assign(session, { status: "complete", payment_status: "paid" });
      expect(await deliver(checkoutCompleted(linked, session, intent, "paid"))).toEqual({
        received: true,
        handled: true,
        duplicate: false,
        orderId: linked.id,
      });

      const paid = await reload(linked.id);
      expect(paid.status).toBe(OrderStatus.PAID);
      expect(paid.payment.status).toBe(OrderStatus.PAID);
      expect(paid.payment.failureReason).toBeNull();
      expect(paid.payment.paidAt).toBeInstanceOf(Date);
      expect(paid.payment.amountReceived).toBe(session.amount_total! / 100);
      expect(paid.payment.paymentIntentId).toBe(intent);
      expect(paid.payment.capture ?? null).toBeNull();
      expect(paid.bookingStatus ?? null).toBeNull();
      expect(await emailsQueued(linked.id, EmailKind.PAYMENT_CONFIRMATION)).toBe(1);
      expect(await emailsQueued(linked.id, EmailKind.PAYMENT_AUTHORIZED)).toBe(0);
      expect(await auditsOf(linked.id, AuditAction.PAYMENT_SUCCEEDED)).toHaveLength(1);
      expect(await auditsOf(linked.id, AuditAction.PAYMENT_AUTHORIZED)).toHaveLength(0);
      expect(await auditsOf(linked.id, AuditAction.PAYMENT_SESSION_SUPERSEDED)).toHaveLength(0);
    },
  );
});

describe("8 · reconcile records nothing more for a hold already on record, and settles one Stripe reports paid", () => {
  it.each([
    {
      capture: PaymentCaptureStatus.AUTHORIZED,
      hold: async (orderId: string, visit: () => Promise<void>) => {
        await authorize(orderId);
        await visit();
      },
    },
    {
      capture: PaymentCaptureStatus.CAPTURE_FAILED,
      hold: async (orderId: string, visit: () => Promise<void>) => {
        await authorize(orderId);
        await declinedCapture(orderId);
        await visit();
      },
    },
    {
      capture: PaymentCaptureStatus.CAPTURE_PENDING,
      hold: async (orderId: string, visit: () => Promise<void>) => {
        await authorize(orderId);
        await whileCapturing(orderId, visit);
      },
    },
  ])(
    "$capture, Stripe reporting the session complete and unpaid: the success page and the order page reconcile it again and again — every reply 'unpaid' and unchanged, the order untouched, nothing claimed (not authorize:<session>) and no WEBHOOK_DUPLICATE row",
    async ({ capture, hold }) => {
      const linked = await linkedOrder();
      const session = await stripeSessionOf(linked.id);
      let seen: { before: Snapshot; replies: ReconcileResult[]; after: Snapshot } | undefined;

      await hold(linked.id, async () => {
        // The customer authorized at checkout: Stripe reports the session
        // complete and unpaid.
        Object.assign(session, { status: "complete", payment_status: "unpaid" });
        const before = await snapshot(linked.id);
        const replies = [
          await reconcileFromSuccessPage(linked.id, session.id),
          await reconcileFromOrderPage(linked.id),
          await reconcileFromSuccessPage(linked.id, session.id),
          await reconcileFromOrderPage(linked.id),
        ];
        seen = { before, replies, after: await snapshot(linked.id) };
      });

      expect(seen).toBeDefined();
      const { before, replies, after } = seen!;
      expect(before.order.payment.capture?.status).toBe(capture);
      for (const reply of replies) {
        expect(reply).toMatchObject({ changed: false, stripeStatus: "unpaid" });
        expect(reply.order.status).toBe(before.order.status);
        expect(reply.order.payment.capture?.status).toBe(capture);
      }
      expect(after.order).toEqual(before.order);
      expect(after.trail).toEqual(before.trail);
      expect(after.trail.claims).not.toContain(`authorize:${session.id}`);
      expect(after.trail.audits).not.toContain(AuditAction.WEBHOOK_DUPLICATE);
    },
  );

  it.each([
    {
      capture: PaymentCaptureStatus.CAPTURE_FAILED,
      story: "the operator's capture reached Stripe but its answer never came back",
      via: "the order page",
      settle: async (orderId: string, check: () => Promise<void>) => {
        const intents = stripeIntents();
        const realCapture = intents.capture.bind(intents) as (
          ...args: unknown[]
        ) => Promise<unknown>;
        vi.spyOn(intents, "capture").mockImplementationOnce((async (...args: unknown[]) => {
          await realCapture(...args);
          throw Object.assign(new Error(CAPTURE_TIMED_OUT), { type: "StripeConnectionError" });
        }) as never);
        await expect(capturePayment(orderId, { actor: admin })).rejects.toBeInstanceOf(
          PaymentError,
        );
        expect((await reload(orderId)).payment.capture?.lastError).toBe(CAPTURE_TIMED_OUT);
        await check();
      },
      reconcile: (orderId: string) => reconcileFromOrderPage(orderId),
    },
    {
      capture: PaymentCaptureStatus.CAPTURE_PENDING,
      story: "Stripe took the money while the operator's capture still waits on its answer",
      via: "the success page",
      settle: async (orderId: string, check: () => Promise<void>) => {
        await whileCapturing(orderId, check, { stripeFirst: true });
      },
      reconcile: (orderId: string, sessionId: string) =>
        reconcileFromSuccessPage(orderId, sessionId),
    },
  ])(
    "$capture ($story), Stripe now reporting the session paid, reconciled from $via: PAID, the capture CAPTURED (capturedAt, the amount Stripe reports, no error), the booking CONFIRMED, ONE receipt",
    async ({ capture, settle, reconcile }) => {
      const linked = await linkedOrder();
      const session = await stripeSessionOf(linked.id);
      await authorize(linked.id);
      let seen:
        | {
            before: Awaited<ReturnType<typeof reload>>;
            since: number;
            reply: ReconcileResult;
            settled: Awaited<ReturnType<typeof reload>>;
            receipts: number;
          }
        | undefined;

      await settle(linked.id, async () => {
        const before = await reload(linked.id);
        // The hold became a charge at Stripe.
        Object.assign(session, { status: "complete", payment_status: "paid" });
        const since = Date.now();
        const reply = await reconcile(linked.id, session.id);
        seen = {
          before,
          since,
          reply,
          settled: await reload(linked.id),
          receipts: await emailsQueued(linked.id, EmailKind.PAYMENT_CONFIRMATION),
        };
      });

      expect(seen).toBeDefined();
      const { before, since, reply, settled, receipts } = seen!;
      expect(before.status).toBe(OrderStatus.LINK_GENERATED);
      expect(before.payment.capture?.status).toBe(capture);
      expect(reply).toMatchObject({ changed: true, stripeStatus: "paid" });
      expect(reply.order.status).toBe(OrderStatus.PAID);
      expect(reply.order.payment.capture?.status).toBe(PaymentCaptureStatus.CAPTURED);
      expect(settled.status).toBe(OrderStatus.PAID);
      expect(settled.payment.status).toBe(OrderStatus.PAID);
      expect(settled.payment.paidAt).toBeInstanceOf(Date);
      expect(settled.payment.capture).toMatchObject({
        method: CaptureMode.MANUAL,
        status: PaymentCaptureStatus.CAPTURED,
        amountCaptured: session.amount_total! / 100,
        lastError: null,
      });
      expect(settled.payment.capture?.capturedAt).toBeInstanceOf(Date);
      expect(settled.payment.capture!.capturedAt!.getTime()).toBeGreaterThanOrEqual(since);
      expect(settled.bookingStatus).toBe(BookingStatus.CONFIRMED);
      expect(receipts).toBe(1);

      // Asked again: already PAID, nothing more.
      expect(await reconcile(linked.id, session.id)).toMatchObject({
        changed: false,
        stripeStatus: "paid",
      });
      expect(await emailsQueued(linked.id, EmailKind.PAYMENT_CONFIRMATION)).toBe(1);
      const succeeded = await auditsOf(linked.id, AuditAction.PAYMENT_SUCCEEDED);
      expect(succeeded.map(meta)).toEqual([
        expect.objectContaining({ source: "reconcile", eventId: `reconcile:${session.id}` }),
      ]);
      const after = await reload(linked.id);
      expect(after.status).toBe(OrderStatus.PAID);
      expect(after.payment.capture?.status).toBe(PaymentCaptureStatus.CAPTURED);
    },
  );
});

describe("9 · an order is never archived over a live card hold — archived, it could be neither captured nor released", () => {
  it.each([
    {
      capture: PaymentCaptureStatus.AUTHORIZED,
      hold: async (orderId: string, attempt: () => Promise<void>) => {
        await authorize(orderId);
        await attempt();
      },
    },
    {
      capture: PaymentCaptureStatus.CAPTURE_FAILED,
      hold: async (orderId: string, attempt: () => Promise<void>) => {
        await authorize(orderId);
        await declinedCapture(orderId);
        await attempt();
      },
    },
    {
      capture: PaymentCaptureStatus.CAPTURE_PENDING,
      hold: async (orderId: string, attempt: () => Promise<void>) => {
        await authorize(orderId);
        await whileCapturing(orderId, attempt);
      },
    },
  ])(
    "$capture → 409 'This order has a live card hold. Capture or release it before archiving.'; the order untouched and nothing recorded",
    async ({ capture, hold }) => {
      const linked = await linkedOrder();
      let seen:
        | { before: Snapshot; res: Awaited<ReturnType<typeof archive>>; after: Snapshot }
        | undefined;

      await hold(linked.id, async () => {
        const before = await snapshot(linked.id);
        const res = await archive(linked.id);
        seen = { before, res, after: await snapshot(linked.id) };
      });

      expect(seen).toBeDefined();
      const { before, res, after } = seen!;
      expect(before.order.payment.capture?.status).toBe(capture);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        ok: false,
        error: { code: "CONFLICT", message: LIVE_HOLD_ARCHIVE },
      });
      expect(after.order).toEqual(before.order);
      expect(after.order.state).toBe(RecordState.ACTIVE);
      expect(after.trail).toEqual(before.trail);
      expect(await auditsOf(linked.id, AuditAction.ORDER_ARCHIVED)).toHaveLength(0);
    },
  );

  it.each([
    {
      order: "a manual-capture order before its authorization (PENDING_AUTHORIZATION)",
      mode: CaptureMode.MANUAL,
      capture: PaymentCaptureStatus.PENDING_AUTHORIZATION,
      reach: async () => {},
    },
    {
      order: "a released hold (CANCELLED)",
      mode: CaptureMode.MANUAL,
      capture: PaymentCaptureStatus.CANCELLED,
      reach: async (order: OrderDTO) => {
        await authorize(order.id);
        await cancelAuthorization(order.id, { actor: admin }, { reason: "Supplier could not confirm" });
      },
    },
    {
      order: "a hold that lapsed at Stripe (AUTHORIZATION_EXPIRED)",
      mode: CaptureMode.MANUAL,
      capture: PaymentCaptureStatus.AUTHORIZATION_EXPIRED,
      reach: async (order: OrderDTO) => {
        const held = await authorize(order.id);
        await deliver(intentCanceled(order, held.payment.paymentIntentId!, "automatic"));
      },
    },
    {
      order: "an automatic-capture order (no capture record)",
      mode: CaptureMode.AUTOMATIC,
      capture: null,
      reach: async () => {},
    },
  ])(
    "still archives $order: 200, ARCHIVED, the capture record as it was, ORDER_ARCHIVED audited",
    async ({ mode, capture, reach }) => {
      await setRentalMode(mode);
      const linked = await linkedOrder();
      await reach(linked);
      expect((await reload(linked.id)).payment.capture?.status ?? null).toBe(capture);

      const res = await archive(linked.id);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expectOk(res.body);
      expect(res.body.data.state).toBe(RecordState.ARCHIVED);
      const after = await reload(linked.id);
      expect(after.state).toBe(RecordState.ARCHIVED);
      expect(after.payment.capture?.status ?? null).toBe(capture);
      expect(await auditsOf(linked.id, AuditAction.ORDER_ARCHIVED)).toHaveLength(1);
    },
  );
});
