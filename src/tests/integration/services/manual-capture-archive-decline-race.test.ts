import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import type Stripe from "stripe";

import { DELETE as archiveOrderRoute } from "@/app/api/orders/[id]/route";
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
import { getDefaultGateway } from "@/server/payments/gateways";
import { getGatewayForOrganization } from "@/server/payments/resolve-gateway";
import { createOrder, initiatePayment } from "@/server/services/order.service";
import {
  cancelAuthorization,
  capturePayment,
} from "@/server/services/payment-capture.service";
import { createSettings } from "@/tests/factories/settings.factory";
import {
  buildAmountCapturableUpdated,
  buildCheckoutCompleted,
  buildCheckoutExpired,
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
 * Two manual-capture races, on Rental Confirmation — the DEFAULT
 * organization, switched to MANUAL the way
 * `scripts/set-organization-capture-mode.ts` does it — through the real entry
 * points: Stripe's signed events posted to the deployment endpoint, POST
 * /api/webhooks/stripe, and the order page's Archive button, DELETE
 * /api/orders/[id], under an ADMIN session.
 *
 *  1. A card declined at checkout fails the order only while its hold is
 *     still pending. Before the authorization lands the order knows no
 *     PaymentIntent (in production a Checkout Session has none until the
 *     customer pays), so the decline's handler first asks Stripe which intent
 *     the order's session holds — a gateway round-trip between reading the
 *     order and writing it. When the customer's next card is authorized on
 *     the same checkout and Stripe's notice of it commits during that
 *     round-trip, the decline finds a hold that stands: the order stays as the
 *     authorization left it (AUTHORIZED, still PAYMENT_PENDING, no failure
 *     reason), no PAYMENT_FAILED audit or evidence is written, and the decline
 *     is answered as a duplicate — Stripe's retry of it too, which is never
 *     recorded as a declined capture. One PAYMENT_AUTHORIZED email is queued
 *     and the operator captures the hold. The same goes when an earlier card
 *     had already failed the order: the authorization puts it back in
 *     progress and the racing decline does not fail it again; and when the
 *     hold has gone further still before the decline is written — the
 *     operator's capture of it at Stripe (CAPTURE_PENDING) or declined
 *     (CAPTURE_FAILED): nothing is failed, the decline adds no capture
 *     failure of its own, and the capture goes through. Without the race a
 *     decline on a pending hold fails the order exactly as before. An
 *     automatic-capture order's decline fails it exactly as before too — even
 *     on a link it has since replaced, whether or not it knows the new link's
 *     intent — and Stripe is never asked about its session, not even once
 *     its organization has switched to MANUAL.
 *  2. Archiving an order whose hold is still pending (PENDING_AUTHORIZATION,
 *     with a Checkout Session on record) first retires its checkout, so no
 *     authorization can land on an order that could then be neither captured
 *     nor released. Stripe is asked for the session:
 *       open      → expired at Stripe, then archived (an order whose request
 *                   went out ends EXPIRED; a declined one stays FAILED)
 *       complete  → 409 "The customer has completed checkout on this order…",
 *                   the order untouched; the hold then lands on the still
 *                   active order and the operator captures it
 *       expired, or a status Stripe does not name → archived, nothing expired
 *     An expiry the gateway refuses is the same 409, the order untouched. A
 *     lookup that fails fails the archive (500), the order untouched; asked
 *     again once Stripe answers, the archive goes through. A live hold
 *     (AUTHORIZED, CAPTURE_PENDING, CAPTURE_FAILED) is refused exactly as
 *     before, without asking Stripe; a released or lapsed one (CANCELLED,
 *     AUTHORIZATION_EXPIRED) archives exactly as before, without asking
 *     Stripe, though its checkout reads complete; and an automatic-capture
 *     order archives exactly as before, without a single Stripe call — even
 *     once its organization has switched to MANUAL.
 *
 * The Stripe stub mints a PaymentIntent with every Checkout Session and the
 * app records it on the order; tests that need production's shape clear it
 * themselves (`withoutRecordedIntent`). Stripe's adapter treats an expiry as
 * best-effort and swallows Stripe's refusal, so a refused expiry is staged on
 * the gateway itself.
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
const CHECKOUT_COMPLETED_ARCHIVE =
  "The customer has completed checkout on this order. Refresh it, then capture or release the hold before archiving.";
const LIVE_HOLD_ARCHIVE =
  "This order has a live card hold. Capture or release it before archiving.";
const ALREADY_AUTHORIZED =
  "The customer has already authorized this payment. Capture or release the hold instead of sending another request.";

const CARD_DECLINED = "Your card was declined.";

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

type Caller = "operator" | "stripe";

/** Whose request is being served. Stripe's carries none of the operator's
 *  cookies — no organization selected — and the race below lands one of
 *  Stripe's deliveries in the middle of another. */
const callers: Caller[] = [];

async function inRequestOf<T>(caller: Caller, run: () => Promise<T>): Promise<T> {
  const enter = (c: Caller | undefined) =>
    c === "stripe" ? setNextHeaders({}) : actingAsOperator();
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

/** Stripe's two notices of one authorization on `session`:
 *  payment_intent.amount_capturable_updated, and checkout.session.completed
 *  reporting the session "unpaid" (authorized, not charged). */
function authorizationNotices(order: OrderRef, session: StubSession, paymentIntentId: string) {
  return {
    "payment_intent.amount_capturable_updated": buildAmountCapturableUpdated({
      paymentIntentId,
      orderId: order.id,
      orderNumber: order.orderNumber,
      amountCapturable: session.amount_total!,
    }),
    "checkout.session.completed": buildCheckoutCompleted({
      sessionId: session.id,
      paymentIntentId,
      orderId: order.id,
      orderNumber: order.orderNumber,
      amountTotal: session.amount_total ?? undefined,
      customerEmail: CUSTOMER_EMAIL,
      paymentStatus: "unpaid",
    }),
  };
}

type AuthorizationNotice = keyof ReturnType<typeof authorizationNotices>;

/* ------------------------------------------------------------------ *
 * The operator and the order
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

type StoredOrder = Awaited<ReturnType<typeof reload>>;

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
async function declinedCapture(orderId: string) {
  getCurrentTestStripe().failNextCapture({ code: "card_declined", message: CARD_DECLINED });
  await expect(capturePayment(orderId, { actor: admin })).rejects.toBeInstanceOf(
    PaymentError,
  );
  const after = await reload(orderId);
  expect(after.payment.capture?.status).toBe(PaymentCaptureStatus.CAPTURE_FAILED);
  return after;
}

/**
 * The operator's "Capture payment", with `during` run while it is in flight
 * (the order says CAPTURE_PENDING), before Stripe takes the money. The
 * capture then completes.
 */
async function whileCapturing(orderId: string, during: () => Promise<void>) {
  const intents = stripeIntents();
  const realCapture = intents.capture.bind(intents) as (...args: unknown[]) => Promise<unknown>;
  let inFlight: string | null | undefined;
  vi.spyOn(intents, "capture").mockImplementationOnce((async (...args: unknown[]) => {
    inFlight = (await reload(orderId)).payment.capture?.status;
    await during();
    return realCapture(...args);
  }) as never);

  await capturePayment(orderId, { actor: admin });

  expect(inFlight).toBe(PaymentCaptureStatus.CAPTURE_PENDING);
  const captured = await reload(orderId);
  expect(captured.status).toBe(OrderStatus.PAID);
  expect(captured.payment.capture?.status).toBe(PaymentCaptureStatus.CAPTURED);
  return captured;
}

/** The operator captures the hold: PAID, CAPTURED, the booking CONFIRMED,
 *  Stripe asked to capture exactly `paymentIntentId`, one receipt. */
async function capturedByOperator(orderId: string, paymentIntentId: string) {
  await capturePayment(orderId, { actor: admin });
  const captured = await reload(orderId);
  expect(captured.status).toBe(OrderStatus.PAID);
  expect(captured.payment.capture?.status).toBe(PaymentCaptureStatus.CAPTURED);
  expect(captured.bookingStatus).toBe(BookingStatus.CONFIRMED);
  expect(getCurrentTestStripe().capturesRequested.map((c) => c.id)).toEqual([paymentIntentId]);
  expect(await emailsQueued(orderId, EmailKind.PAYMENT_CONFIRMATION)).toBe(1);
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

/** The operator sends the payment request: one email to the customer, and
 *  the order PAYMENT_PENDING. */
async function requested(orderId: string) {
  const sent = await sendRequest(orderId);
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  expect(sent.emails).toHaveLength(1);
  expect(sent.emails[0]!.to).toBe(CUSTOMER_EMAIL);
  const after = await reload(orderId);
  expect(after.status).toBe(OrderStatus.PAYMENT_PENDING);
  return after;
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

/* ------------------------------------------------------------------ *
 * The Stripe stub, and the gateway in front of it
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
  status: string | null;
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

/** The customer's card went through on `session`: Stripe reports it
 *  complete and unpaid (authorized, not charged), holding `intentId`. */
function checkoutAuthorized(session: StubSession, intentId: string) {
  Object.assign(session, {
    status: "complete",
    payment_status: "unpaid",
    payment_intent: intentId,
  });
}

/** Every method the Stripe stub offers, spied from now on — any request to
 *  Stripe goes through one of them. Returns the names of those called. */
function watchStripe() {
  const stripe = getCurrentTestStripe().asStripe();
  type Surface = Record<string, (...args: never[]) => unknown>;
  const surfaces: Array<[string, Surface]> = [
    ["checkout.sessions", stripe.checkout.sessions as unknown as Surface],
    ["paymentIntents", stripe.paymentIntents as unknown as Surface],
    ["webhooks", stripe.webhooks as unknown as Surface],
  ];
  const spies = surfaces.flatMap(([surface, methods]) =>
    Object.keys(methods)
      .filter((name) => typeof methods[name] === "function")
      .map((name) => ({ name: `${surface}.${name}`, spy: vi.spyOn(methods, name) })),
  );
  expect(spies.map((s) => s.name)).toEqual(
    expect.arrayContaining([
      "checkout.sessions.create",
      "checkout.sessions.expire",
      "checkout.sessions.retrieve",
      "paymentIntents.capture",
      "paymentIntents.cancel",
      "paymentIntents.retrieve",
      "webhooks.constructEvent",
      "webhooks.generateTestHeaderString",
    ]),
  );
  return () => spies.filter(({ spy }) => spy.mock.calls.length > 0).map(({ name }) => name);
}

/** The gateway Rental Confirmation's orders run on: having no credentials of
 *  its own, the default organization uses the deployment's Stripe gateway. */
async function rentalGateway() {
  const gateway = getDefaultGateway();
  expect(await getGatewayForOrganization(String(rental), PaymentGatewayKey.STRIPE)).toBe(
    gateway,
  );
  return gateway;
}

/* ------------------------------------------------------------------ *
 * The trail
 * ------------------------------------------------------------------ */

const auditsOf = (orderId: string, action: AuditAction) =>
  AuditLog.find({ entityId: orderId, action }).sort({ createdAt: 1 }).lean();

/** Evidence entries of one type — or only those recorded for one Stripe
 *  event. */
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

/** An archive the operator was refused: `status`, and the order exactly as
 *  it was — still ACTIVE, nothing recorded about it. */
async function expectArchiveRefused(
  res: Awaited<ReturnType<typeof archive>>,
  before: Snapshot,
  refusal: { status: number; code: string; message: string },
) {
  expect(res.status, JSON.stringify(res.body)).toBe(refusal.status);
  expect(res.body).toMatchObject({
    ok: false,
    error: { code: refusal.code, message: refusal.message },
  });
  const after = await snapshot(before.order._id.toString());
  expect(after.order).toEqual(before.order);
  expect(after.order.state).toBe(RecordState.ACTIVE);
  expect(after.trail).toEqual(before.trail);
  expect(await auditsOf(before.order._id.toString(), AuditAction.ORDER_ARCHIVED)).toHaveLength(0);
}

/** An archive that went through: 200, the order ARCHIVED with `status`, its
 *  capture record and session as they were, ORDER_ARCHIVED audited once. */
async function expectArchived(
  res: Awaited<ReturnType<typeof archive>>,
  before: StoredOrder,
  status: OrderStatus,
) {
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expectOk(res.body);
  expect(res.body.data.state).toBe(RecordState.ARCHIVED);
  const orderId = before._id.toString();
  const after = await reload(orderId);
  expect(after.state).toBe(RecordState.ARCHIVED);
  expect(after.status).toBe(status);
  expect(after.payment.status).toBe(status);
  expect(after.payment.capture ?? null).toEqual(before.payment.capture ?? null);
  expect(after.payment.stripeSessionId).toBe(before.payment.stripeSessionId);
  expect(after.payment.paymentIntentId ?? null).toBe(before.payment.paymentIntentId ?? null);
  expect(await auditsOf(orderId, AuditAction.ORDER_ARCHIVED)).toHaveLength(1);
  return after;
}

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

describe("1 · a card declined at checkout fails the order only while its hold is still pending", () => {
  it.each([
    {
      notice: "payment_intent.amount_capturable_updated",
      other: "checkout.session.completed",
    },
    {
      notice: "checkout.session.completed",
      other: "payment_intent.amount_capturable_updated",
    },
  ] as const satisfies ReadonlyArray<{ notice: AuthorizationNotice; other: AuthorizationNotice }>)(
    "the race (production shape): Stripe's $notice for the customer's next card commits while the decline's handler asks Stripe about the session — the decline changes nothing (still AUTHORIZED and PAYMENT_PENDING, no failure reason), is answered as a duplicate with no PAYMENT_FAILED audit or evidence, and so is Stripe's retry of it (never a declined capture); $other is a duplicate; ONE PAYMENT_AUTHORIZED email; the operator captures the hold",
    async ({ notice, other }) => {
      const linked = await linkedOrder();
      await requested(linked.id);
      const { session, intentId } = await withoutRecordedIntent(linked.id);
      const notices = authorizationNotices(linked, session, intentId);
      const sessions = stripeSessions();
      const realRetrieve = sessions.retrieve.bind(sessions) as (id: string) => Promise<unknown>;
      let raced:
        | { read: string | null | undefined; authorization: WebhookReply; held: StoredOrder }
        | undefined;
      const retrieve = vi.spyOn(sessions, "retrieve").mockImplementation((async (id: string) => {
        if (id === session.id && !raced) {
          // The decline's handler has read the order and is asking Stripe
          // which intent its session holds. Meanwhile Checkout, still open,
          // takes the customer's next card on the same intent, and Stripe's
          // notice of the authorization commits first.
          const read = (await reload(linked.id)).payment.capture?.status;
          checkoutAuthorized(session, intentId);
          const authorization = await deliver(notices[notice]);
          raced = { read, authorization, held: await reload(linked.id) };
        }
        return realRetrieve(id);
      }) as never);
      const decline = declinedAtCheckout(linked, intentId);

      expect(await deliver(decline)).toEqual({
        received: true,
        handled: true,
        duplicate: true,
        orderId: linked.id,
      });

      // The decline's own lookup — the round-trip the authorization landed in.
      expect(retrieve).toHaveBeenCalledTimes(1);
      expect(retrieve).toHaveBeenCalledWith(session.id);
      expect(raced).toBeDefined();
      const { read, authorization, held } = raced!;
      expect(read).toBe(PaymentCaptureStatus.PENDING_AUTHORIZATION);
      expect(authorization).toEqual({
        received: true,
        handled: true,
        duplicate: false,
        orderId: linked.id,
      });
      expect(held.payment.capture).toMatchObject({
        method: CaptureMode.MANUAL,
        status: PaymentCaptureStatus.AUTHORIZED,
        amountAuthorized: held.pricing.amount,
      });

      // Exactly as the authorization left it: nothing about it says failed.
      const after = await reload(linked.id);
      expect(after).toEqual(held);
      expect(after.status).toBe(OrderStatus.PAYMENT_PENDING);
      expect(after.payment.status).toBe(OrderStatus.PAYMENT_PENDING);
      expect(after.payment.failureReason ?? null).toBeNull();
      expect(after.payment.paymentIntentId).toBe(intentId);
      expect(after.payment.capture?.status).toBe(PaymentCaptureStatus.AUTHORIZED);
      expect(after.payment.capture?.lastError ?? null).toBeNull();
      expect(after.payment.processedWebhookEventIds).not.toContain(decline.id);
      expect(after.bookingStatus).toBe(BookingStatus.PENDING);
      expect(await auditsOf(linked.id, AuditAction.PAYMENT_FAILED)).toHaveLength(0);
      expect(await evidenceOf(linked.id, OrderEvidenceEventType.PAYMENT_FAILED)).toBe(0);
      expect(await auditsOf(linked.id, AuditAction.PAYMENT_CAPTURE_FAILED)).toHaveLength(0);
      expect(await auditsOf(linked.id, AuditAction.PAYMENT_SESSION_SUPERSEDED)).toHaveLength(0);
      expect(await auditsOf(linked.id, AuditAction.PAYMENT_AUTHORIZED)).toHaveLength(1);
      expect(await emailsQueued(linked.id, EmailKind.PAYMENT_AUTHORIZED)).toBe(1);

      // Stripe's retry of the decline finds the hold standing on the very
      // intent it names: still a duplicate, not a declined capture.
      expect(await deliver(decline)).toEqual({
        received: true,
        handled: true,
        duplicate: true,
        orderId: linked.id,
      });
      expect(await reload(linked.id)).toEqual(held);
      expect(await auditsOf(linked.id, AuditAction.PAYMENT_CAPTURE_FAILED)).toHaveLength(0);
      expect(await evidenceOf(linked.id, OrderEvidenceEventType.PAYMENT_CAPTURE_FAILED)).toBe(0);
      expect(await auditsOf(linked.id, AuditAction.PAYMENT_FAILED)).toHaveLength(0);

      // Stripe's other notice of the same authorization adds nothing.
      expect(await deliver(notices[other])).toMatchObject({ handled: true, duplicate: true });
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
      expect(request.emails).toHaveLength(0);
      // …and Capture takes the money.
      await capturedByOperator(linked.id, intentId);
      expect(await auditsOf(linked.id, AuditAction.PAYMENT_FAILED)).toHaveLength(0);
    },
  );

  it("the same race after an earlier card already failed the order (FAILED, production shape): the authorization puts it back in progress — PAYMENT_PENDING, the failure cleared — and the racing decline of the next card does not fail it again: a duplicate, the only PAYMENT_FAILED audit row the earlier card's; the operator captures the hold", async () => {
    const linked = await linkedOrder();
    await requested(linked.id);
    const { session, intentId } = await withoutRecordedIntent(linked.id);
    // The first card is declined; Checkout keeps the session open.
    const earlier = declinedAtCheckout(linked, intentId);
    expect(await deliver(earlier)).toEqual({
      received: true,
      handled: true,
      duplicate: false,
      orderId: linked.id,
    });
    const failed = await reload(linked.id);
    expect(failed.status).toBe(OrderStatus.FAILED);
    expect(failed.payment.failureReason).toBe(CARD_DECLINED);
    expect(failed.payment.capture?.status).toBe(PaymentCaptureStatus.PENDING_AUTHORIZATION);

    const notices = authorizationNotices(linked, session, intentId);
    const sessions = stripeSessions();
    const realRetrieve = sessions.retrieve.bind(sessions) as (id: string) => Promise<unknown>;
    let raced:
      | {
          read: { status: string; capture: string | null | undefined };
          authorization: WebhookReply;
          held: StoredOrder;
        }
      | undefined;
    const retrieve = vi.spyOn(sessions, "retrieve").mockImplementation((async (id: string) => {
      if (id === session.id && !raced) {
        // The second card's decline is being handled; the third card goes
        // through on the same checkout, and its notice commits first.
        const current = await reload(linked.id);
        const read = { status: current.status, capture: current.payment.capture?.status };
        checkoutAuthorized(session, intentId);
        const authorization = await deliver(notices["payment_intent.amount_capturable_updated"]);
        raced = { read, authorization, held: await reload(linked.id) };
      }
      return realRetrieve(id);
    }) as never);
    const racing = declinedAtCheckout(linked, intentId);

    expect(await deliver(racing)).toEqual({
      received: true,
      handled: true,
      duplicate: true,
      orderId: linked.id,
    });

    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(retrieve).toHaveBeenCalledWith(session.id);
    expect(raced).toBeDefined();
    const { read, authorization, held } = raced!;
    expect(read).toEqual({
      status: OrderStatus.FAILED,
      capture: PaymentCaptureStatus.PENDING_AUTHORIZATION,
    });
    expect(authorization).toEqual({
      received: true,
      handled: true,
      duplicate: false,
      orderId: linked.id,
    });
    const after = await reload(linked.id);
    expect(after).toEqual(held);
    expect(after.status).toBe(OrderStatus.PAYMENT_PENDING);
    expect(after.payment.status).toBe(OrderStatus.PAYMENT_PENDING);
    expect(after.payment.failureReason).toBeNull();
    expect(after.payment.capture?.status).toBe(PaymentCaptureStatus.AUTHORIZED);
    expect(after.payment.processedWebhookEventIds).not.toContain(racing.id);
    const rows = await auditsOf(linked.id, AuditAction.PAYMENT_FAILED);
    expect(rows.map((row) => meta(row).eventId)).toEqual([earlier.id]);
    expect(await evidenceOf(linked.id, OrderEvidenceEventType.PAYMENT_FAILED, racing.id)).toBe(0);
    expect(await emailsQueued(linked.id, EmailKind.PAYMENT_AUTHORIZED)).toBe(1);

    await capturedByOperator(linked.id, intentId);
  });

  it.each([
    {
      capture: PaymentCaptureStatus.CAPTURE_FAILED,
      further: "the operator captured it and Stripe declined the capture",
      declinedCaptures: 1,
    },
    {
      capture: PaymentCaptureStatus.CAPTURE_PENDING,
      further: "the operator's capture of it is still at Stripe",
      declinedCaptures: 0,
    },
  ] as const)(
    "the race with the hold gone further by the time the decline is written ($capture: $further), production shape — the decline still fails nothing (PAYMENT_PENDING, no failure reason, the hold left $capture), is a duplicate with no PAYMENT_FAILED audit or evidence and no capture failure of its own, and so is Stripe's retry of it; the capture then goes through",
    async ({ capture, declinedCaptures }) => {
      const linked = await linkedOrder();
      await requested(linked.id);
      const { session, intentId } = await withoutRecordedIntent(linked.id);
      const notice =
        authorizationNotices(linked, session, intentId)["payment_intent.amount_capturable_updated"];
      const sessions = stripeSessions();
      const intents = stripeIntents();
      const realRetrieve = sessions.retrieve.bind(sessions) as (id: string) => Promise<unknown>;
      const realCapture = intents.capture.bind(intents) as (...args: unknown[]) => Promise<unknown>;
      // CAPTURE_PENDING: Stripe sits on the operator's capture until `answer`.
      let atStripe!: () => void;
      const captureAtStripe = new Promise<void>((resolve) => {
        atStripe = resolve;
      });
      let answer!: () => void;
      const stripeAnswers = new Promise<void>((resolve) => {
        answer = resolve;
      });
      let capturing: Promise<unknown> | undefined;
      let entered = false;
      let raced:
        | { read: string | null | undefined; authorization: WebhookReply; held: StoredOrder }
        | undefined;
      const retrieve = vi.spyOn(sessions, "retrieve").mockImplementation((async (id: string) => {
        if (id === session.id && !entered) {
          entered = true;
          // The decline's handler has read the order and is asking Stripe
          // about its session. Meanwhile the next card is authorized on the
          // same checkout, its notice commits, and the operator — seeing the
          // hold — presses Capture before the decline is written.
          const read = (await reload(linked.id)).payment.capture?.status;
          checkoutAuthorized(session, intentId);
          const authorization = await deliver(notice);
          if (capture === PaymentCaptureStatus.CAPTURE_FAILED) {
            await inRequestOf("operator", async () => {
              await declinedCapture(linked.id);
            });
          } else {
            vi.spyOn(intents, "capture").mockImplementationOnce((async (...args: unknown[]) => {
              atStripe();
              await stripeAnswers;
              return realCapture(...args);
            }) as never);
            await inRequestOf("operator", async () => {
              capturing = capturePayment(linked.id, { actor: admin }).then(
                () => null,
                (err: unknown) => err,
              );
              await captureAtStripe;
            });
          }
          raced = { read, authorization, held: await reload(linked.id) };
        }
        return realRetrieve(id);
      }) as never);
      const decline = declinedAtCheckout(linked, intentId);

      expect(await deliver(decline)).toEqual({
        received: true,
        handled: true,
        duplicate: true,
        orderId: linked.id,
      });

      expect(retrieve).toHaveBeenCalledTimes(1);
      expect(retrieve).toHaveBeenCalledWith(session.id);
      expect(raced).toBeDefined();
      const { read, authorization, held } = raced!;
      expect(read).toBe(PaymentCaptureStatus.PENDING_AUTHORIZATION);
      expect(authorization).toEqual({
        received: true,
        handled: true,
        duplicate: false,
        orderId: linked.id,
      });
      expect(held.payment.capture?.status).toBe(capture);

      const after = await reload(linked.id);
      expect(after).toEqual(held);
      expect(after.status).toBe(OrderStatus.PAYMENT_PENDING);
      expect(after.payment.status).toBe(OrderStatus.PAYMENT_PENDING);
      expect(after.payment.failureReason ?? null).toBeNull();
      expect(after.payment.processedWebhookEventIds).not.toContain(decline.id);
      expect(await auditsOf(linked.id, AuditAction.PAYMENT_FAILED)).toHaveLength(0);
      expect(await evidenceOf(linked.id, OrderEvidenceEventType.PAYMENT_FAILED)).toBe(0);
      // A declined capture on record is the operator's own attempt, never
      // the checkout decline's.
      const captureFailures = await auditsOf(linked.id, AuditAction.PAYMENT_CAPTURE_FAILED);
      expect(captureFailures).toHaveLength(declinedCaptures);
      expect(captureFailures.map((row) => meta(row).eventId ?? null)).not.toContain(decline.id);
      expect(await evidenceOf(linked.id, OrderEvidenceEventType.PAYMENT_CAPTURE_FAILED)).toBe(0);

      expect(await deliver(decline)).toEqual({
        received: true,
        handled: true,
        duplicate: true,
        orderId: linked.id,
      });
      expect(await reload(linked.id)).toEqual(held);
      expect(await auditsOf(linked.id, AuditAction.PAYMENT_CAPTURE_FAILED)).toHaveLength(
        declinedCaptures,
      );
      expect(await auditsOf(linked.id, AuditAction.PAYMENT_FAILED)).toHaveLength(0);

      // The capture in flight completes; a declined one is retried.
      if (capture === PaymentCaptureStatus.CAPTURE_PENDING) {
        expect(capturing).toBeDefined();
        answer();
        expect(await capturing).toBeNull();
      } else {
        await capturePayment(linked.id, { actor: admin });
      }
      const captured = await reload(linked.id);
      expect(captured.status).toBe(OrderStatus.PAID);
      expect(captured.payment.capture?.status).toBe(PaymentCaptureStatus.CAPTURED);
      expect(captured.payment.failureReason ?? null).toBeNull();
      expect(captured.bookingStatus).toBe(BookingStatus.CONFIRMED);
      expect(getCurrentTestStripe().capturesRequested.map((c) => c.id)).toEqual(
        Array.from({ length: declinedCaptures + 1 }, () => intentId),
      );
      expect(await emailsQueued(linked.id, EmailKind.PAYMENT_CONFIRMATION)).toBe(1);
      expect(await emailsQueued(linked.id, EmailKind.PAYMENT_AUTHORIZED)).toBe(1);
      expect(await auditsOf(linked.id, AuditAction.PAYMENT_FAILED)).toHaveLength(0);
    },
  );

  it.each([
    {
      shape: "production",
      when: "the order knows no intent yet (production): Stripe is asked which intent its session holds, and names the declined one",
    },
    {
      shape: "recorded",
      when: "the order knows its intent: compared directly, Stripe not asked",
    },
  ] as const)(
    "without the race, a decline on a pending hold fails the order exactly as before — $when: FAILED with the decline, the hold still PENDING_AUTHORIZATION, ONE PAYMENT_FAILED audit row and evidence entry, nothing superseded; a replay is a duplicate",
    async ({ shape }) => {
      const linked = await linkedOrder();
      await requested(linked.id);
      const session = await stripeSessionOf(linked.id);
      const intentId = session.payment_intent!;
      if (shape === "production") await withoutRecordedIntent(linked.id);
      const before = await reload(linked.id);
      expect(before.payment.capture?.status).toBe(PaymentCaptureStatus.PENDING_AUTHORIZATION);
      const retrieve = vi.spyOn(stripeSessions(), "retrieve");
      const decline = declinedAtCheckout(linked, intentId);

      expect(await deliver(decline)).toEqual({
        received: true,
        handled: true,
        duplicate: false,
        orderId: linked.id,
      });

      if (shape === "production") {
        expect(retrieve).toHaveBeenCalledTimes(1);
        expect(retrieve).toHaveBeenCalledWith(session.id);
      } else {
        expect(retrieve).not.toHaveBeenCalled();
      }
      const failed = await reload(linked.id);
      expect(failed.status).toBe(OrderStatus.FAILED);
      expect(failed.payment.status).toBe(OrderStatus.FAILED);
      expect(failed.payment.failureReason).toBe(CARD_DECLINED);
      expect(failed.payment.capture).toEqual(before.payment.capture);
      expect(failed.payment.stripeSessionId).toBe(session.id);
      expect(failed.payment.paymentIntentId ?? null).toBe(before.payment.paymentIntentId ?? null);
      expect(failed.payment.processedWebhookEventIds).toContain(decline.id);
      expect(failed.bookingStatus).toBe(before.bookingStatus);
      const rows = await auditsOf(linked.id, AuditAction.PAYMENT_FAILED);
      expect(rows.map(meta)).toEqual([
        expect.objectContaining({ reason: CARD_DECLINED, eventId: decline.id }),
      ]);
      expect(String(rows[0]!.organizationId)).toBe(String(rental));
      expect(
        await evidenceOf(linked.id, OrderEvidenceEventType.PAYMENT_FAILED, decline.id),
      ).toBe(1);
      expect(await auditsOf(linked.id, AuditAction.PAYMENT_SESSION_SUPERSEDED)).toHaveLength(0);
      expect(await auditsOf(linked.id, AuditAction.PAYMENT_CAPTURE_FAILED)).toHaveLength(0);

      expect(await deliver(decline)).toMatchObject({ handled: true, duplicate: true });
      expect(await auditsOf(linked.id, AuditAction.PAYMENT_FAILED)).toHaveLength(1);
      expect(await reload(linked.id)).toEqual(failed);
    },
  );

  it.each([
    {
      link: "on its current link, knowing no intent yet (production)",
      replaced: false,
      recorded: false,
    },
    {
      link: "on a link it has since replaced, knowing no intent yet (production: Stripe's retry of link A's decline after link B, not yet opened, was issued)",
      replaced: true,
      recorded: false,
    },
    {
      link: "on a link it has since replaced, knowing link B's intent (compared with it, the decline would read as history)",
      replaced: true,
      recorded: true,
    },
  ])(
    "an automatic-capture order (no capture record, its organization since switched to MANUAL), declined $link: FAILED exactly as before — ONE PAYMENT_FAILED audit row and evidence entry, nothing superseded — and Stripe is never asked about its session",
    async ({ replaced, recorded }) => {
      await setRentalMode(CaptureMode.AUTOMATIC);
      const linked = await linkedOrder();
      let declinedIntent: string;
      if (replaced) {
        declinedIntent = (await stripeSessionOf(linked.id)).payment_intent!;
        const res = await regenerate(linked.id);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        if (recorded) {
          const sessionB = await stripeSessionOf(linked.id);
          expect(sessionB.payment_intent).toEqual(expect.any(String));
          expect(sessionB.payment_intent).not.toBe(declinedIntent);
          expect((await reload(linked.id)).payment.paymentIntentId).toBe(sessionB.payment_intent);
        } else {
          const { session: sessionB, intentId: intentB } = await withoutRecordedIntent(linked.id);
          expect(intentB).not.toBe(declinedIntent);
          // Asked, Stripe would say link B holds no intent yet — the decline
          // would read as history.
          sessionB.payment_intent = null;
        }
      } else {
        await requested(linked.id);
        ({ intentId: declinedIntent } = await withoutRecordedIntent(linked.id));
      }
      // The order keeps its own capture mode: automatic, no capture record.
      await setRentalMode(CaptureMode.MANUAL);
      const before = await reload(linked.id);
      expect(before.status).toBe(OrderStatus.PAYMENT_PENDING);
      expect(before.payment.capture ?? null).toBeNull();
      const retrieve = vi.spyOn(stripeSessions(), "retrieve");
      const decline = declinedAtCheckout(linked, declinedIntent);

      expect(await deliver(decline)).toEqual({
        received: true,
        handled: true,
        duplicate: false,
        orderId: linked.id,
      });

      expect(retrieve).not.toHaveBeenCalled();
      const failed = await reload(linked.id);
      expect(failed.status).toBe(OrderStatus.FAILED);
      expect(failed.payment.status).toBe(OrderStatus.FAILED);
      expect(failed.payment.failureReason).toBe(CARD_DECLINED);
      expect(failed.payment.capture ?? null).toBeNull();
      expect(failed.bookingStatus ?? null).toBeNull();
      expect(failed.payment.stripeSessionId).toBe(before.payment.stripeSessionId);
      const rows = await auditsOf(linked.id, AuditAction.PAYMENT_FAILED);
      expect(rows.map(meta)).toEqual([
        expect.objectContaining({ reason: CARD_DECLINED, eventId: decline.id }),
      ]);
      expect(
        await evidenceOf(linked.id, OrderEvidenceEventType.PAYMENT_FAILED, decline.id),
      ).toBe(1);
      expect(await auditsOf(linked.id, AuditAction.PAYMENT_SESSION_SUPERSEDED)).toHaveLength(0);
      expect(await emailsQueued(linked.id, EmailKind.PAYMENT_AUTHORIZED)).toBe(0);
    },
  );
});

describe("2 · archiving an order whose hold is still pending retires its checkout first", () => {
  /** How the order stands when the operator archives it, and the status an
   *  archive leaves it in. */
  const PENDING_HOLDS: Array<{
    order: string;
    reach: (order: OrderRef, intentId: string) => Promise<void>;
    archivedAs: OrderStatus;
  }> = [
    {
      order: "PAYMENT_PENDING (the request went out; the customer has not paid)",
      reach: async () => {},
      archivedAs: OrderStatus.EXPIRED,
    },
    {
      order: "FAILED (a card declined at checkout; Checkout keeps the session open for another)",
      reach: async (order: OrderRef, intentId: string) => {
        await deliver(declinedAtCheckout(order, intentId));
        expect((await reload(order.id)).status).toBe(OrderStatus.FAILED);
      },
      archivedAs: OrderStatus.FAILED,
    },
  ];

  /** A manual-capture order whose request went out, as production stores it
   *  before the authorization (no intent recorded), standing as `reach`
   *  leaves it; and its Checkout Session. */
  async function pendingHold(reach: (order: OrderRef, intentId: string) => Promise<void>) {
    const linked = await linkedOrder();
    await requested(linked.id);
    const { session, intentId } = await withoutRecordedIntent(linked.id);
    await reach(linked, intentId);
    const before = await reload(linked.id);
    expect(before.payment.capture?.status).toBe(PaymentCaptureStatus.PENDING_AUTHORIZATION);
    expect(before.payment.stripeSessionId).toBe(session.id);
    return { linked, session, intentId, before };
  }

  it.each(PENDING_HOLDS)(
    "the order $order: Stripe announces the expiry the archive itself caused (checkout.session.expired) BEFORE the archive's write lands, as it does in production → still archived (EXPIRED), the capture record untouched, ORDER_ARCHIVED audited once",
    async ({ reach }) => {
      const { linked, session } = await pendingHold(reach);
      const sessions = stripeSessions();
      const realExpire = sessions.expire.bind(sessions) as (id: string) => Promise<unknown>;
      vi.spyOn(sessions, "expire").mockImplementationOnce((async (id: string) => {
        const expired = await realExpire(id);
        // Stripe's webhook for that expiry, processed while the archive is
        // still between its re-check and its write.
        await deliver(
          buildCheckoutExpired({
            sessionId: id,
            orderId: linked.id,
            orderNumber: linked.orderNumber,
          }),
        );
        expect((await reload(linked.id)).status).toBe(OrderStatus.EXPIRED);
        return expired;
      }) as never);

      const res = await archive(linked.id);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const after = await reload(linked.id);
      expect(after.state).toBe(RecordState.ARCHIVED);
      expect(after.status).toBe(OrderStatus.EXPIRED);
      expect(after.payment.capture?.status).toBe(PaymentCaptureStatus.PENDING_AUTHORIZATION);
      expect(after.payment.stripeSessionId).toBe(session.id);
      expect(await auditsOf(linked.id, AuditAction.ORDER_ARCHIVED)).toHaveLength(1);
    },
  );

  it.each(PENDING_HOLDS)(
    "Stripe reports the session open, the order $order → Stripe asked to expire the order's session BEFORE the archive is written, then 200, ARCHIVED ($archivedAs), the capture record untouched, ORDER_ARCHIVED audited",
    async ({ reach, archivedAs }) => {
      const { linked, session, before } = await pendingHold(reach);
      expect(session.status).toBe("open");
      const gateway = await rentalGateway();
      const expireSession = vi.spyOn(gateway, "expireSession");
      const sessions = stripeSessions();
      const retrieve = vi.spyOn(sessions, "retrieve");
      const realExpire = sessions.expire.bind(sessions) as (id: string) => Promise<unknown>;
      let stateWhenExpired: string | undefined;
      const expire = vi.spyOn(sessions, "expire").mockImplementationOnce((async (id: string) => {
        stateWhenExpired = (await reload(linked.id)).state;
        return realExpire(id);
      }) as never);

      const res = await archive(linked.id);

      await expectArchived(res, before, archivedAs);
      // Asked before the expiry and again after it: only Stripe's "expired"
      // lets the archive through (its adapter swallows a refused expiry).
      expect(retrieve).toHaveBeenCalledTimes(2);
      expect(retrieve).toHaveBeenNthCalledWith(1, session.id);
      expect(retrieve).toHaveBeenNthCalledWith(2, session.id);
      expect(expireSession).toHaveBeenCalledTimes(1);
      expect(expireSession).toHaveBeenCalledWith(session.id);
      expect(expire).toHaveBeenCalledTimes(1);
      expect(expire).toHaveBeenCalledWith(session.id);
      // Stripe has expired exactly the order's session — nothing can be
      // authorized on it now.
      expect(getCurrentTestStripe().sessionsExpired).toEqual([session.id]);
      expect(stateWhenExpired).toBe(RecordState.ACTIVE);
    },
  );

  it.each(PENDING_HOLDS)(
    "Stripe reports the session complete (the customer authorized; Stripe's notice not in yet), the order $order → 409 'The customer has completed checkout on this order…', the order untouched and nothing expired; the hold then lands on the still active order and the operator captures it",
    async ({ reach }) => {
      const { linked, session, intentId } = await pendingHold(reach);
      checkoutAuthorized(session, intentId);
      const before = await snapshot(linked.id);
      const expireSession = vi.spyOn(await rentalGateway(), "expireSession");
      const expire = vi.spyOn(stripeSessions(), "expire");
      const retrieve = vi.spyOn(stripeSessions(), "retrieve");

      const res = await archive(linked.id);

      await expectArchiveRefused(res, before, {
        status: 409,
        code: "CONFLICT",
        message: CHECKOUT_COMPLETED_ARCHIVE,
      });
      expect(retrieve).toHaveBeenCalledTimes(1);
      expect(retrieve).toHaveBeenCalledWith(session.id);
      expect(expireSession).not.toHaveBeenCalled();
      expect(expire).not.toHaveBeenCalled();
      expect(getCurrentTestStripe().sessionsExpired).toEqual([]);

      const held = await authorize(linked.id, intentId);
      expect(held.state).toBe(RecordState.ACTIVE);
      expect(held.status).toBe(OrderStatus.PAYMENT_PENDING);
      expect(await emailsQueued(linked.id, EmailKind.PAYMENT_AUTHORIZED)).toBe(1);
      await capturedByOperator(linked.id, intentId);
    },
  );

  it("the gateway refuses to expire the open session (the customer completed it in the meantime) → the same 409, the order untouched; the hold then lands on the still active order", async () => {
    const { linked, session, intentId } = await pendingHold(async () => {});
    const before = await snapshot(linked.id);
    const gateway = await rentalGateway();
    const expireSession = vi.spyOn(gateway, "expireSession").mockImplementationOnce(async () => {
      checkoutAuthorized(session, intentId);
      throw new Error("This Checkout Session is not in an expirable state.");
    });

    const res = await archive(linked.id);

    await expectArchiveRefused(res, before, {
      status: 409,
      code: "CONFLICT",
      message: CHECKOUT_COMPLETED_ARCHIVE,
    });
    expect(expireSession).toHaveBeenCalledTimes(1);
    expect(expireSession).toHaveBeenCalledWith(session.id);
    expect(getCurrentTestStripe().sessionsExpired).toEqual([]);

    const held = await authorize(linked.id, intentId);
    expect(held.state).toBe(RecordState.ACTIVE);
  });

  it.each([
    { stripeSays: "expired", reads: "expired" },
    { stripeSays: null, reads: "a status Stripe does not name" },
  ])(
    "Stripe reports the session $reads → 200, ARCHIVED (EXPIRED), nothing expired at Stripe",
    async ({ stripeSays }) => {
      const { linked, session, before } = await pendingHold(async () => {});
      session.status = stripeSays;
      const expireSession = vi.spyOn(await rentalGateway(), "expireSession");
      const expire = vi.spyOn(stripeSessions(), "expire");
      const retrieve = vi.spyOn(stripeSessions(), "retrieve");

      const res = await archive(linked.id);

      await expectArchived(res, before, OrderStatus.EXPIRED);
      expect(retrieve).toHaveBeenCalledTimes(1);
      expect(retrieve).toHaveBeenCalledWith(session.id);
      expect(expireSession).not.toHaveBeenCalled();
      expect(expire).not.toHaveBeenCalled();
      expect(getCurrentTestStripe().sessionsExpired).toEqual([]);
    },
  );

  it("a session lookup that fails refuses the archive — 409 'Could not check this order's checkout…', the order untouched, nothing expired; archived once Stripe answers again (the session open: expired, confirmed expired, then archived)", async () => {
    const { linked, session, before } = await pendingHold(async () => {});
    const untouched = await snapshot(linked.id);
    const expireSession = vi.spyOn(await rentalGateway(), "expireSession");
    const retrieve = vi
      .spyOn(stripeSessions(), "retrieve")
      .mockRejectedValueOnce(new Error("Stripe API unreachable"));

    const refused = await archive(linked.id);

    await expectArchiveRefused(refused, untouched, {
      status: 409,
      code: "CONFLICT",
      message:
        "Could not check this order's checkout with the payment provider. Try again in a moment.",
    });
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(retrieve).toHaveBeenCalledWith(session.id);
    expect(expireSession).not.toHaveBeenCalled();
    expect(getCurrentTestStripe().sessionsExpired).toEqual([]);

    const res = await archive(linked.id);

    await expectArchived(res, before, OrderStatus.EXPIRED);
    // Asked before the expiry, and again after it: the adapter swallows a
    // refused expiry, so only Stripe's "expired" lets the archive through.
    expect(retrieve).toHaveBeenCalledTimes(3);
    expect(expireSession).toHaveBeenCalledTimes(1);
    expect(expireSession).toHaveBeenCalledWith(session.id);
    expect(getCurrentTestStripe().sessionsExpired).toEqual([session.id]);
  });

  it("a session Stripe no longer knows (resource_missing — a key, account or mode switch) cannot take a payment: archived without an expiry attempt", async () => {
    const { linked, before } = await pendingHold(async () => {});
    const expireSession = vi.spyOn(await rentalGateway(), "expireSession");
    const missing = Object.assign(new Error("No such checkout.session"), {
      code: "resource_missing",
    });
    vi.spyOn(stripeSessions(), "retrieve").mockRejectedValueOnce(missing);

    const res = await archive(linked.id);

    await expectArchived(res, before, OrderStatus.EXPIRED);
    expect(expireSession).not.toHaveBeenCalled();
    expect(getCurrentTestStripe().sessionsExpired).toEqual([]);
  });

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
    "a live hold ($capture) is refused exactly as before — 409 'This order has a live card hold…', the order untouched — and Stripe is not asked anything",
    async ({ capture, hold }) => {
      const linked = await linkedOrder();
      await requested(linked.id);
      let seen:
        | {
            before: Snapshot;
            res: Awaited<ReturnType<typeof archive>>;
            stripeCalls: string[];
          }
        | undefined;

      await hold(linked.id, async () => {
        const before = await snapshot(linked.id);
        const stripeCalls = watchStripe();
        const res = await archive(linked.id);
        seen = { before, res, stripeCalls: stripeCalls() };
        await expectArchiveRefused(res, before, {
          status: 409,
          code: "CONFLICT",
          message: LIVE_HOLD_ARCHIVE,
        });
      });

      expect(seen).toBeDefined();
      expect(seen!.before.order.payment.capture?.status).toBe(capture);
      expect(seen!.stripeCalls).toEqual([]);
      expect(getCurrentTestStripe().sessionsExpired).toEqual([]);
    },
  );

  it.each([
    {
      hold: "released by the operator (CANCELLED)",
      capture: PaymentCaptureStatus.CANCELLED,
      end: async (order: OrderRef) => {
        await cancelAuthorization(order.id, { actor: admin }, { reason: "Supplier could not confirm" });
      },
    },
    {
      hold: "lapsed at Stripe (AUTHORIZATION_EXPIRED)",
      capture: PaymentCaptureStatus.AUTHORIZATION_EXPIRED,
      end: async (order: OrderRef, intentId: string) => {
        const reply = await deliver(
          buildPaymentIntentCanceled({
            paymentIntentId: intentId,
            orderId: order.id,
            orderNumber: order.orderNumber,
            cancellationReason: "automatic",
          }),
        );
        expect(reply).toMatchObject({ handled: true, duplicate: false });
      },
    },
  ])(
    "a hold $hold, its checkout complete at Stripe as the customer's authorization left it, archives exactly as before — 200, ARCHIVED (EXPIRED), the capture record as it was — and Stripe is not asked anything",
    async ({ capture, end }) => {
      const linked = await linkedOrder();
      await requested(linked.id);
      const session = await stripeSessionOf(linked.id);
      const intentId = session.payment_intent!;
      checkoutAuthorized(session, intentId);
      await authorize(linked.id, intentId);
      await end(linked, intentId);
      const before = await reload(linked.id);
      expect(before.payment.capture?.status).toBe(capture);
      expect(before.status).toBe(OrderStatus.PAYMENT_PENDING);
      expect(session.status).toBe("complete");
      const stripeCalls = watchStripe();

      const res = await archive(linked.id);

      await expectArchived(res, before, OrderStatus.EXPIRED);
      expect(stripeCalls()).toEqual([]);
      expect(getCurrentTestStripe().sessionsExpired).toEqual([]);
    },
  );

  it("an automatic-capture order (no capture record) whose request went out archives exactly as before — 200, ARCHIVED (EXPIRED) — without a single call to Stripe, even with its organization since switched to MANUAL", async () => {
    await setRentalMode(CaptureMode.AUTOMATIC);
    const linked = await linkedOrder();
    await requested(linked.id);
    await setRentalMode(CaptureMode.MANUAL);
    const before = await reload(linked.id);
    expect(before.payment.capture ?? null).toBeNull();
    expect(before.payment.stripeSessionId).toBeTruthy();
    const stripeCalls = watchStripe();

    const res = await archive(linked.id);

    const after = await expectArchived(res, before, OrderStatus.EXPIRED);
    expect(after.payment.capture ?? null).toBeNull();
    expect(stripeCalls()).toEqual([]);
    expect(getCurrentTestStripe().sessionsExpired).toEqual([]);
    expect(getCurrentTestStripe().sessionsCreated).toHaveLength(1);
  });
});
