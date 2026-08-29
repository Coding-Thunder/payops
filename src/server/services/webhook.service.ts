import "server-only";

import { type ClientSession, Types } from "mongoose";

import {
  AuditAction,
  AuditEntity,
  BookingStatus,
  CaptureMode,
  type DisputeStatus,
  EmailKind,
  OrderEvidenceActorType,
  OrderEvidenceEventType,
  OrderStatus,
  PaymentCaptureStatus,
} from "@/lib/constants/enums";
import { DomainEventType } from "@/lib/constants/events";
import { logger } from "@/lib/logger";
import {
  Dispute,
  type DisputeDoc,
  Order,
  type OrderDoc,
  type OrderDocument,
  Organization,
} from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import { publishEvent } from "@/server/events/bus";
import type { VerifiedPaymentEvent } from "@/server/payments/gateway";
import {
  sessionOpt,
  tryClaimGatewayEvent,
  withTx,
} from "@/server/db/transaction";

import { recordAudit } from "./audit.service";
import {
  enqueueEmail,
  kickPostCommitDrain,
} from "./email-outbox.service";
import { captureEvidenceSafe } from "./evidence.service";

interface ProcessEventResult {
  handled: boolean;
  duplicate: boolean;
  orderId?: string;
  reason?: string;
}

/**
 * Idempotently process a gateway-verified event. Repeated calls with the
 * same event id are no-ops. Database mutations are atomic. Email sends
 * are also gated by the order's `confirmationEmailSentAt` so we never
 * double-mail.
 *
 * Accepts a normalised `VerifiedPaymentEvent` produced by any gateway's
 * `verifyWebhook` — the webhook route owns the gateway selection (per
 * route prefix), and this service stays gateway-agnostic.
 */
export async function processGatewayEvent(
  event: VerifiedPaymentEvent,
  /** Organization whose endpoint received this delivery. Null for the
   *  deployment-level Stripe endpoint. Enforced against the order. */
  organizationId: string | null = null,
): Promise<ProcessEventResult> {
  await connectMongo();
  // Captured into a LOCAL and threaded explicitly from here down. It used
  // to live in a module-scoped variable assigned right before an awaited
  // call, which is safe with one delivery in flight but becomes a real
  // hazard as tenants multiply: two concurrent deliveries in one Node
  // process could interleave between the assignment and the check, and the
  // second would be validated against the first's organization. Nothing
  // about the RULE changes — only where the value is carried.
  const endpointOrgId = organizationId;
  logger.info("payments.event", { id: event.eventId, type: event.type });

  // Best-effort: WEBHOOK_RECEIVED is non-transactional — observability
  // only. The dedupe-claim inside each handler is the real guard.
  await recordAudit({
    action: AuditAction.WEBHOOK_RECEIVED,
    entityType: AuditEntity.WEBHOOK,
    entityId: event.eventId,
    metadata: { type: event.type },
  });

  switch (event.type) {
    case "checkout.completed":
      return handleCheckoutCompleted(event, endpointOrgId);
    case "checkout.expired":
      return handleCheckoutExpired(event, endpointOrgId);
    case "checkout.failed":
      return handleCheckoutFailed(event, endpointOrgId);
    case "payment.failed":
      return handlePaymentFailed(event, endpointOrgId);
    case "payment.authorized":
      return handlePaymentAuthorized(event, endpointOrgId);
    case "payment.captured":
      return handlePaymentCaptured(event, endpointOrgId);
    case "payment.cancelled":
      return handlePaymentCancelled(event, endpointOrgId);
    case "dispute.created":
      return handleDisputeCreated(event, endpointOrgId);
    case "dispute.updated":
      return handleDisputeUpdated(event, endpointOrgId);
    case "dispute.closed":
      return handleDisputeClosed(event, endpointOrgId);
    case "dispute.funds_withdrawn":
      return handleDisputeFundsWithdrawn(event, endpointOrgId);
    case "refund.created":
      return handleRefundCreated(event, endpointOrgId);
    case "unhandled":
    default:
      return { handled: false, duplicate: false, reason: "unhandled_event" };
  }
}

/** Back-compat re-export for any caller still on the old name. New code
 *  should import `processGatewayEvent`. */
export const processStripeEvent = processGatewayEvent;


/**
 * A payment event may only touch an order belonging to the SAME
 * organization as the endpoint that received it.
 *
 * Without this, a webhook delivered to one brand's endpoint could mark
 * ANOTHER brand's order paid, purely because the payload carried that
 * order's id. The money would have landed in the first brand's merchant
 * account while the second brand's books recorded the sale — two different
 * legal entities, mismatched settlement, and an audit trail that does not
 * reconcile.
 *
 * The deployment-level endpoint (organization null) may only touch the
 * default organization's orders or unattributed pre-migration ones, which
 * is the same rule stated for that endpoint's own tenant.
 */
async function orderBelongsToEndpoint(
  order: OrderDocument,
  expectedOrganizationId: string | null,
): Promise<boolean> {
  const orderOrg = order.organizationId ? String(order.organizationId) : null;
  if (expectedOrganizationId) return orderOrg === expectedOrganizationId;

  if (orderOrg === null) return true; // pre-migration row
  const def = await Organization.findOne({ isDefault: true })
    .select("_id")
    .lean<{ _id: unknown } | null>();
  return Boolean(def && String(def._id) === orderOrg);
}

async function findOrderForEvent(
  event: VerifiedPaymentEvent,
): Promise<OrderDocument | null> {
  // Order id round-tripped via the gateway's metadata is the most
  // reliable identifier — it survives session-id rotation and works
  // for events that don't carry a session id.
  if (event.orderId && Types.ObjectId.isValid(event.orderId)) {
    const direct = await Order.findById(event.orderId);
    if (direct) return direct;
  }
  if (event.sessionId) {
    const bySession = await Order.findOne({
      "payment.stripeSessionId": event.sessionId,
    });
    if (bySession) return bySession;
  }
  if (event.paymentIntentId) {
    const byIntent = await Order.findOne({
      "payment.paymentIntentId": event.paymentIntentId,
    });
    if (byIntent) return byIntent;
  }
  return null;
}

/**
 * Single chokepoint: every handler goes through this, so the cross-brand
 * check cannot be forgotten by one of them.
 */
async function findOrderForEndpoint(
  event: VerifiedPaymentEvent,
  expectedOrganizationId: string | null,
): Promise<OrderDocument | null> {
  const order = await findOrderForEvent(event);
  if (!order) return null;
  if (await orderBelongsToEndpoint(order, expectedOrganizationId)) return order;

  logger.error("payments.cross_organization_event", {
    eventId: event.eventId,
    type: event.type,
    orderId: String(order._id),
    orderOrganizationId: order.organizationId
      ? String(order.organizationId)
      : null,
    endpointOrganizationId: expectedOrganizationId,
  });
  await recordAudit({
    action: AuditAction.WEBHOOK_FAILED,
    entityType: AuditEntity.WEBHOOK,
    entityId: event.eventId,
    metadata: {
      reason: "cross_organization_event",
      type: event.type,
      orderId: String(order._id),
      orderOrganizationId: order.organizationId
        ? String(order.organizationId)
        : null,
      endpointOrganizationId: expectedOrganizationId,
    },
  });
  // Treated as "not our order": the handler reports order_not_found and the
  // record is left completely untouched.
  return null;
}

async function handleCheckoutCompleted(
  event: VerifiedPaymentEvent,
  endpointOrgId: string | null,
): Promise<ProcessEventResult> {
  const order = await findOrderForEndpoint(event, endpointOrgId);
  if (!order) {
    logger.warn("payments.order_not_found_for_session", {
      sessionId: event.sessionId,
    });
    return { handled: false, duplicate: false, reason: "order_not_found" };
  }
  // DEFENCE IN DEPTH, on the ORDER rather than on the payload.
  //
  // The gateway adapter already reroutes a `checkout.session.completed`
  // whose session reports `payment_status: "unpaid"` to "payment.authorized",
  // and that is the primary guard. This is the second one: if such an event
  // ever reached here anyway — a synthetic replay, a fixture missing
  // `payment_status`, a future Stripe shape change — marking a
  // manual-capture order PAID would tell the operator money had arrived
  // when Stripe is merely holding it, and would email the customer a
  // receipt for a charge that never happened.
  //
  // An order that has genuinely been captured has already left
  // PENDING_AUTHORIZATION/AUTHORIZED, so a real post-capture completion
  // event still passes. `payment.capture` is null on every order both
  // incumbent brands have, so this branch is unreachable for them.
  const capture = order.payment?.capture;
  if (
    capture?.method === CaptureMode.MANUAL &&
    (capture.status === PaymentCaptureStatus.PENDING_AUTHORIZATION ||
      capture.status === PaymentCaptureStatus.AUTHORIZED)
  ) {
    logger.warn("payments.checkout_completed_on_uncaptured_manual_order", {
      orderId: String(order._id),
      eventId: event.eventId,
      captureStatus: capture.status,
    });
    return applyPaymentAuthorized(order, {
      eventId: event.eventId,
      paymentIntentId: event.paymentIntentId,
      amountAuthorizedMinor: event.amountTotalMinor,
      authorizedAtMs: event.occurredAtMs,
      source: "webhook",
    });
  }

  return applyCheckoutPaid(order, {
    eventId: event.eventId,
    sessionId: event.sessionId ?? order.payment.stripeSessionId ?? "",
    paymentIntentId: event.paymentIntentId,
    amountTotal: event.amountTotalMinor,
    paidAtMs: event.occurredAtMs,
    source: "webhook",
  });
}

interface PaidTransitionInput {
  /** Idempotency key appended to the order's processed-events list.
   *  Webhook supplies the Stripe event id; reconciliation synthesizes
   *  one from the session + a timestamp. Same key applied twice is a
   *  no-op. */
  eventId: string;
  sessionId: string;
  paymentIntentId: string | null;
  /** Stripe minor-unit amount. When null we fall back to the order's
   *  pricing.amount — same defensive default the original webhook used. */
  amountTotal: number | null;
  paidAtMs: number;
  source: "webhook" | "reconcile";
}

/**
 * Drives a PENDING order to PAID and emits side-effects.
 *
 * Shared by:
 *  - the Stripe webhook handler (default path)
 *  - the reconcile endpoint when a customer reports they paid but the
 *    webhook never landed (local dev without `stripe listen`, dropped
 *    delivery, throttled retry)
 *
 * Idempotent on three axes:
 *  1. `processedWebhookEventIds` — same event id is never applied twice
 *  2. `confirmationEmailSentAt`  — single confirmation send (see
 *     sendConfirmationOnce)
 *  3. `isAlreadyPaid` snapshot   — domain event + email skipped when
 *     the order was already PAID prior to this call
 */
export async function applyCheckoutPaid(
  order: OrderDocument,
  input: PaidTransitionInput,
): Promise<ProcessEventResult> {
  const gatewayKey = order.payment.gateway ?? "STRIPE";

  type TxOutcome =
    | { duplicate: true }
    | {
        duplicate: false;
        didTransition: boolean;
        previousStatus: OrderStatus;
        updated: OrderDoc & { _id: Types.ObjectId };
        amountReceived: number;
      };

  const outcome: TxOutcome = await withTx(async (session) => {
    // 1. Durable dedupe — the unique index on `gatewayEventId` is the
    // real idempotency primitive. Webhook + reconcile races collapse
    // here. The Order array push below is defense-in-depth.
    const claimed = await tryClaimGatewayEvent(
      {
        gatewayEventId: input.eventId,
        gateway: gatewayKey,
        orderId: String(order._id),
      },
      session,
    );
    if (!claimed) {
      return { duplicate: true };
    }

    const isAlreadyPaid = order.status === OrderStatus.PAID;
    const amountReceived =
      typeof input.amountTotal === "number"
        ? input.amountTotal / 100
        : order.pricing.amount;

    // 2. Conditional update — flips PENDING/LINK_GENERATED → PAID
    // exactly once. The `status: { $ne: PAID }` guard is the
    // serialization point against webhook-vs-reconcile races that
    // synthesize DIFFERENT dedupe keys (`evt_xyz` vs `reconcile:cs_xyz`)
    // — both pass the ProcessedWebhookEvent claim, but only one can
    // flip the status. The loser falls through to the duplicate branch
    // and never enqueues a second confirmation email.
    //
    // The $push is capped at -50 via $slice so the legacy array stays
    // bounded over the order lifetime.
    const updated = await Order.findOneAndUpdate(
      {
        _id: order._id,
        status: { $ne: OrderStatus.PAID },
        "payment.processedWebhookEventIds": { $ne: input.eventId },
      },
      {
        $set: {
          status: OrderStatus.PAID,
          "payment.status": OrderStatus.PAID,
          "payment.paidAt": new Date(input.paidAtMs),
          "payment.amountReceived": amountReceived,
          "payment.paymentIntentId":
            input.paymentIntentId ?? (order.payment.paymentIntentId ?? null),
          "payment.failureReason": null,
        },
        $push: {
          "payment.processedWebhookEventIds": {
            $each: [input.eventId],
            $slice: -50,
          },
        },
      },
      { ...sessionOpt(session), returnDocument: "after" },
    ).lean<OrderDoc & { _id: Types.ObjectId }>();

    if (!updated) {
      // Order is already PAID (another transition won the race).
      // No audit, no evidence, no outbox enqueue — exactly one
      // confirmation email lifecycle per order.
      return { duplicate: true };
    }

    // 3. Audit + evidence (in-tx; failure aborts everything).
    await recordAudit(
      {
        action: AuditAction.PAYMENT_SUCCEEDED,
        entityType: AuditEntity.PAYMENT,
        entityId: String(updated._id),
        // Attribute the row to the order's tenant. Webhook deliveries carry no
        // request scope, so without this the row is written unattributed — and
        // a null-organization audit row is visible ONLY to the default
        // organization, hiding a brand's own payment trail from it.
        organizationId: updated.organizationId ?? null,
        metadata: {
          orderNumber: updated.orderNumber,
          sessionId: input.sessionId,
          amountReceived,
          currency: updated.pricing.currency,
          eventId: input.eventId,
          source: input.source,
          consentStatus: updated.consent?.status ?? "NOT_REQUESTED",
          consentId: updated.consent?.currentConsentId
            ? String(updated.consent.currentConsentId)
            : null,
        },
      },
      session,
    );

    await captureEvidenceSafe(
      {
        orderId: String(updated._id),
        orderNumber: updated.orderNumber,
        eventType: OrderEvidenceEventType.PAYMENT_COMPLETED,
        occurredAt: new Date(input.paidAtMs),
        actor: { type: OrderEvidenceActorType.GATEWAY, name: input.source },
        payload: {
          gateway: updated.payment.gateway ?? null,
          gatewayEventId: input.eventId,
          paymentSessionId: input.sessionId,
          paymentIntentId: input.paymentIntentId ?? null,
          amountReceived,
          currency: updated.pricing.currency,
          paidAt: new Date(input.paidAtMs).toISOString(),
          source: input.source,
          consentStatus: updated.consent?.status ?? "NOT_REQUESTED",
          consentId: updated.consent?.currentConsentId
            ? String(updated.consent.currentConsentId)
            : null,
        },
        refs: {
          gatewayEventId: input.eventId,
          paymentSessionId: input.sessionId,
          paymentIntentId: input.paymentIntentId ?? null,
          transactionId: input.paymentIntentId ?? null,
          customerEmail: updated.customer.email,
        },
      },
      session,
    );

    // 4. Enqueue confirmation email — in-tx so the row never lands
    // if the order update aborts. `isAlreadyPaid` only fires for the
    // edge case where the in-memory order doc passed in was already
    // PAID before this call (would have been caught above by the
    // `status: { $ne: PAID }` filter), but the guard is kept for
    // defensive symmetry.
    if (!isAlreadyPaid) {
      await enqueueEmail(
        {
          orderId: String(updated._id),
          kind: EmailKind.PAYMENT_CONFIRMATION,
          recipient: updated.customer.email,
        },
        session,
      );
    }

    return {
      duplicate: false,
      didTransition: !isAlreadyPaid,
      previousStatus: order.status,
      updated,
      amountReceived,
    };
  });

  // 5. After commit: lifecycle log + domain-event publish + fast-path
  // drain. Side effects run only when we actually transitioned the
  // order (not on duplicate replays).
  if (outcome.duplicate) {
    await recordAudit({
      action: AuditAction.WEBHOOK_DUPLICATE,
      entityType: AuditEntity.WEBHOOK,
      entityId: input.eventId,
      metadata: { orderId: String(order._id), source: input.source },
    });
    return { handled: true, duplicate: true, orderId: String(order._id) };
  }

  if (outcome.didTransition) {
    logger.info("order.lifecycle.transition", {
      orderId: String(outcome.updated._id),
      orderNumber: outcome.updated.orderNumber,
      previousState: outcome.previousStatus,
      nextState: OrderStatus.PAID,
      transition: "paid",
      source: `service.webhook.${input.source}`,
      eventId: input.eventId,
    });
    publishEvent({
      type: DomainEventType.ORDER_PAID,
      audience: {
        kind: "creator",
        userId: String(outcome.updated.createdBy.userId),
      },
      payload: {
        orderId: String(outcome.updated._id),
        orderNumber: outcome.updated.orderNumber,
        amountReceived: outcome.amountReceived,
        currency: outcome.updated.pricing.currency,
        customerName: outcome.updated.customer.name,
      },
    });
    // Fast-path: try to deliver the confirmation email immediately so
    // the customer sees it sub-second. If this fails or the process
    // dies before it finishes, the 60s in-process drainer (or a
    // restart) picks the row up.
    kickPostCommitDrain();
  }

  return {
    handled: true,
    duplicate: false,
    orderId: String(outcome.updated._id),
  };
}

// `sendConfirmationOnce` and `orderDocToDTO` are gone. The confirmation
// email now lands in the `PendingEmail` outbox inside the same
// transaction that flips the order to PAID — the post-commit
// `kickPostCommitDrain` ships it sub-second on the happy path, and a
// 60s in-process drainer (plus restarts) retries on transient SMTP
// failures. No more inline retry-on-duplicate-webhook footgun.

async function handleCheckoutExpired(
  event: VerifiedPaymentEvent,
  endpointOrgId: string | null,
): Promise<ProcessEventResult> {
  const order = await findOrderForEndpoint(event, endpointOrgId);
  if (!order) {
    return { handled: false, duplicate: false, reason: "order_not_found" };
  }
  if (order.status === OrderStatus.PAID) {
    return { handled: true, duplicate: true, orderId: String(order._id) };
  }
  // A manual-capture session reaches `complete` at authorization and the
  // CHECKOUT session can then expire while the AUTHORIZATION is still
  // perfectly live and capturable. Driving the order to EXPIRED there
  // would tell the operator the money is gone while Stripe is still
  // holding it. Written as its own early return rather than by widening
  // the update filter below, because `payment.capture` is null on every
  // order both incumbent brands have — so this branch is provably never
  // taken for them and their query shape is unchanged.
  if (
    order.payment?.capture?.status === PaymentCaptureStatus.AUTHORIZED ||
    order.payment?.capture?.status === PaymentCaptureStatus.CAPTURE_PENDING
  ) {
    logger.info("payments.checkout_expired_ignored_live_authorization", {
      orderId: String(order._id),
      captureStatus: order.payment.capture.status,
    });
    return { handled: true, duplicate: true, orderId: String(order._id) };
  }

  const gatewayKey = order.payment.gateway ?? "STRIPE";

  type Outcome =
    | { duplicate: true }
    | { duplicate: false; updated: OrderDoc & { _id: Types.ObjectId } };

  const outcome: Outcome = await withTx(async (session) => {
    const claimed = await tryClaimGatewayEvent(
      {
        gatewayEventId: event.eventId,
        gateway: gatewayKey,
        orderId: String(order._id),
      },
      session,
    );
    if (!claimed) return { duplicate: true };

    const updated = await Order.findOneAndUpdate(
      {
        _id: order._id,
        status: { $ne: OrderStatus.PAID },
        "payment.processedWebhookEventIds": { $ne: event.eventId },
      },
      {
        $set: {
          status: OrderStatus.EXPIRED,
          "payment.status": OrderStatus.EXPIRED,
        },
        $push: {
          "payment.processedWebhookEventIds": {
            $each: [event.eventId],
            $slice: -50,
          },
        },
      },
      { ...sessionOpt(session), returnDocument: "after" },
    ).lean<OrderDoc & { _id: Types.ObjectId }>();

    if (!updated) return { duplicate: true };

    await recordAudit(
      {
        action: AuditAction.PAYMENT_EXPIRED,
        entityType: AuditEntity.PAYMENT,
        entityId: String(updated._id),
        // Attribute the row to the order's tenant. Webhook deliveries carry no
        // request scope, so without this the row is written unattributed — and
        // a null-organization audit row is visible ONLY to the default
        // organization, hiding a brand's own payment trail from it.
        organizationId: updated.organizationId ?? null,
        metadata: { sessionId: event.sessionId, eventId: event.eventId },
      },
      session,
    );

    await captureEvidenceSafe(
      {
        orderId: String(updated._id),
        orderNumber: updated.orderNumber,
        eventType: OrderEvidenceEventType.PAYMENT_EXPIRED,
        occurredAt: new Date(event.occurredAtMs),
        actor: { type: OrderEvidenceActorType.GATEWAY, name: "webhook" },
        payload: {
          gateway: updated.payment.gateway ?? null,
          gatewayEventId: event.eventId,
          paymentSessionId: event.sessionId ?? null,
          reason: event.reason ?? null,
        },
        refs: {
          gatewayEventId: event.eventId,
          paymentSessionId: event.sessionId ?? null,
          customerEmail: updated.customer.email,
        },
      },
      session,
    );

    return { duplicate: false, updated };
  });

  if (outcome.duplicate) {
    return { handled: true, duplicate: true, orderId: String(order._id) };
  }

  logger.info("order.lifecycle.transition", {
    orderId: String(outcome.updated._id),
    orderNumber: outcome.updated.orderNumber,
    previousState: order.status,
    nextState: OrderStatus.EXPIRED,
    transition: "expired",
    source: "service.webhook.checkout_expired",
    eventId: event.eventId,
  });
  publishEvent({
    type: DomainEventType.ORDER_EXPIRED,
    audience: {
      kind: "creator",
      userId: String(outcome.updated.createdBy.userId),
    },
    payload: {
      orderId: String(outcome.updated._id),
      orderNumber: outcome.updated.orderNumber,
      customerName: outcome.updated.customer.name,
    },
  });

  return {
    handled: true,
    duplicate: false,
    orderId: String(outcome.updated._id),
  };
}

async function handleCheckoutFailed(
  event: VerifiedPaymentEvent,
  endpointOrgId: string | null,
): Promise<ProcessEventResult> {
  const order = await findOrderForEndpoint(event, endpointOrgId);
  if (!order) {
    return { handled: false, duplicate: false, reason: "order_not_found" };
  }
  return failOrder(
    order,
    event,
    event.reason ?? `Async payment failed for session ${event.sessionId}`,
  );
}

async function handlePaymentFailed(
  event: VerifiedPaymentEvent,
  endpointOrgId: string | null,
): Promise<ProcessEventResult> {
  const order = await findOrderForEndpoint(event, endpointOrgId);
  if (!order) {
    return { handled: false, duplicate: false, reason: "order_not_found" };
  }
  const reason =
    event.reason ??
    `Payment intent ${event.paymentIntentId ?? "?"} failed`;

  // Under manual capture, Stripe also fires `payment_intent.payment_failed`
  // when a CAPTURE attempt is declined. Running that through `failOrder`
  // would mark the order FAILED — a terminal payment state — while the
  // authorization may well still stand and be capturable on retry. Record
  // it as a capture failure instead and leave `status`/`payment.status`
  // alone.
  //
  // `payment.capture` is null for every automatic-capture order, so
  // `failOrder` runs byte-for-byte as it does today for both incumbents.
  const captureStatus = order.payment?.capture?.status;
  if (
    captureStatus === PaymentCaptureStatus.AUTHORIZED ||
    captureStatus === PaymentCaptureStatus.CAPTURE_PENDING
  ) {
    await Order.updateOne(
      { _id: order._id, "payment.capture.method": CaptureMode.MANUAL },
      {
        $set: {
          "payment.capture.status": PaymentCaptureStatus.CAPTURE_FAILED,
          "payment.capture.lastError": reason.slice(0, 512),
        },
      },
    );
    await recordAudit({
      action: AuditAction.PAYMENT_CAPTURE_FAILED,
      entityType: AuditEntity.PAYMENT,
      entityId: String(order._id),
      organizationId: order.organizationId ?? null,
      metadata: {
        orderNumber: order.orderNumber,
        reason,
        eventId: event.eventId,
      },
    });
    await captureEvidenceSafe({
      orderId: String(order._id),
      orderNumber: order.orderNumber,
      eventType: OrderEvidenceEventType.PAYMENT_CAPTURE_FAILED,
      occurredAt: new Date(event.occurredAtMs),
      actor: { type: OrderEvidenceActorType.GATEWAY, name: "webhook" },
      payload: {
        gatewayEventId: event.eventId,
        paymentIntentId: event.paymentIntentId ?? null,
        reason,
        note: "Capture was declined. The order is NOT marked failed.",
      },
      refs: {
        gatewayEventId: event.eventId,
        paymentIntentId: event.paymentIntentId ?? null,
        customerEmail: order.customer.email,
      },
    });
    return { handled: true, duplicate: false, orderId: String(order._id) };
  }

  return failOrder(order, event, reason);
}

async function failOrder(
  order: OrderDocument,
  event: VerifiedPaymentEvent,
  reason: string,
): Promise<ProcessEventResult> {
  if (order.status === OrderStatus.PAID) {
    return { handled: true, duplicate: true, orderId: String(order._id) };
  }

  const gatewayKey = order.payment.gateway ?? "STRIPE";

  type Outcome =
    | { duplicate: true }
    | { duplicate: false; updated: OrderDoc & { _id: Types.ObjectId } };

  const outcome: Outcome = await withTx(async (session) => {
    const claimed = await tryClaimGatewayEvent(
      {
        gatewayEventId: event.eventId,
        gateway: gatewayKey,
        orderId: String(order._id),
      },
      session,
    );
    if (!claimed) return { duplicate: true };

    const updated = await Order.findOneAndUpdate(
      {
        _id: order._id,
        status: { $ne: OrderStatus.PAID },
        "payment.processedWebhookEventIds": { $ne: event.eventId },
      },
      {
        $set: {
          status: OrderStatus.FAILED,
          "payment.status": OrderStatus.FAILED,
          "payment.failureReason": reason,
        },
        $push: {
          "payment.processedWebhookEventIds": {
            $each: [event.eventId],
            $slice: -50,
          },
        },
      },
      { ...sessionOpt(session), returnDocument: "after" },
    ).lean<OrderDoc & { _id: Types.ObjectId }>();

    if (!updated) return { duplicate: true };

    await recordAudit(
      {
        action: AuditAction.PAYMENT_FAILED,
        entityType: AuditEntity.PAYMENT,
        entityId: String(updated._id),
        // Attribute the row to the order's tenant. Webhook deliveries carry no
        // request scope, so without this the row is written unattributed — and
        // a null-organization audit row is visible ONLY to the default
        // organization, hiding a brand's own payment trail from it.
        organizationId: updated.organizationId ?? null,
        metadata: { reason, eventId: event.eventId },
      },
      session,
    );

    await captureEvidenceSafe(
      {
        orderId: String(updated._id),
        orderNumber: updated.orderNumber,
        eventType: OrderEvidenceEventType.PAYMENT_FAILED,
        occurredAt: new Date(event.occurredAtMs),
        actor: { type: OrderEvidenceActorType.GATEWAY, name: "webhook" },
        payload: {
          gateway: updated.payment.gateway ?? null,
          gatewayEventId: event.eventId,
          paymentSessionId: event.sessionId ?? null,
          paymentIntentId: event.paymentIntentId ?? null,
          reason,
        },
        refs: {
          gatewayEventId: event.eventId,
          paymentSessionId: event.sessionId ?? null,
          paymentIntentId: event.paymentIntentId ?? null,
          customerEmail: updated.customer.email,
        },
      },
      session,
    );

    return { duplicate: false, updated };
  });

  if (outcome.duplicate) {
    return { handled: true, duplicate: true, orderId: String(order._id) };
  }

  logger.info("order.lifecycle.transition", {
    orderId: String(outcome.updated._id),
    orderNumber: outcome.updated.orderNumber,
    previousState: order.status,
    nextState: OrderStatus.FAILED,
    transition: "failed",
    source: "service.webhook.payment_failed",
    eventId: event.eventId,
    reason,
  });
  publishEvent({
    type: DomainEventType.ORDER_FAILED,
    audience: {
      kind: "creator",
      userId: String(outcome.updated.createdBy.userId),
    },
    payload: {
      orderId: String(outcome.updated._id),
      orderNumber: outcome.updated.orderNumber,
      customerName: outcome.updated.customer.name,
      reason,
    },
  });

  return {
    handled: true,
    duplicate: false,
    orderId: String(outcome.updated._id),
  };
}

/* ─────────────────── Manual-capture (authorize → capture) ──────────────── */

/**
 * How long a Stripe authorization stands before the gateway releases it on
 * its own. Stored on the order so an operator can see the deadline; Stripe
 * remains the authority and tells us via `payment_intent.canceled`.
 */
const AUTHORIZATION_HOLD_DAYS = 7;

interface AuthorizedTransitionInput {
  eventId: string;
  paymentIntentId: string | null;
  amountAuthorizedMinor: number | null;
  authorizedAtMs: number;
  source: "webhook" | "reconcile";
}

/**
 * Drive a manual-capture order to AUTHORIZED.
 *
 * THIS DELIBERATELY DOES NOT TOUCH `status` OR `payment.status`. The
 * customer's card has been authorized, not charged — the money has not
 * moved and the order is not PAID. Conflating the two is the exact failure
 * this whole change exists to prevent, and keeping OrderStatus out of it is
 * also what keeps the six `status: PAID` analytics aggregations honest: an
 * authorized-but-uncaptured order is correctly not counted as revenue.
 *
 * What it DOES set is the separate booking-lifecycle field
 * (`bookingStatus: PENDING`) and the authorization bookkeeping under
 * `payment.capture`.
 *
 * Shared by the webhook handler and the reconcile endpoint, with disjoint
 * idempotency-key namespaces (`evt_…` vs `authorize:<sessionId>`), exactly
 * as `applyCheckoutPaid` is.
 */
export async function applyPaymentAuthorized(
  order: OrderDocument,
  input: AuthorizedTransitionInput,
): Promise<ProcessEventResult> {
  const gatewayKey = order.payment.gateway ?? "STRIPE";
  const authorizedAt = new Date(input.authorizedAtMs);

  type TxOutcome =
    | { duplicate: true }
    | { duplicate: false; updated: OrderDoc & { _id: Types.ObjectId } };

  const outcome: TxOutcome = await withTx(async (session) => {
    const claimed = await tryClaimGatewayEvent(
      {
        gatewayEventId: input.eventId,
        gateway: gatewayKey,
        orderId: String(order._id),
      },
      session,
    );
    if (!claimed) return { duplicate: true };

    const amountAuthorized =
      typeof input.amountAuthorizedMinor === "number"
        ? input.amountAuthorizedMinor / 100
        : order.pricing.amount;

    // Only an order that is still awaiting its authorization may take it.
    // A second delivery of `amount_capturable_updated` — which Stripe does
    // send — finds the status already AUTHORIZED and falls through to the
    // duplicate branch rather than re-stamping the timestamps.
    const updated = await Order.findOneAndUpdate(
      {
        _id: order._id,
        "payment.capture.method": CaptureMode.MANUAL,
        "payment.capture.status": PaymentCaptureStatus.PENDING_AUTHORIZATION,
        "payment.processedWebhookEventIds": { $ne: input.eventId },
      },
      {
        $set: {
          "payment.capture.status": PaymentCaptureStatus.AUTHORIZED,
          "payment.capture.authorizedAt": authorizedAt,
          "payment.capture.amountAuthorized": amountAuthorized,
          "payment.capture.captureExpiresAt": new Date(
            input.authorizedAtMs + AUTHORIZATION_HOLD_DAYS * 86_400_000,
          ),
          "payment.capture.lastError": null,
          "payment.paymentIntentId":
            input.paymentIntentId ?? (order.payment.paymentIntentId ?? null),
          bookingStatus: BookingStatus.PENDING,
        },
        $push: {
          "payment.processedWebhookEventIds": {
            $each: [input.eventId],
            $slice: -50,
          },
        },
      },
      { ...sessionOpt(session), returnDocument: "after" },
    ).lean<OrderDoc & { _id: Types.ObjectId }>();

    if (!updated) return { duplicate: true };

    await recordAudit(
      {
        action: AuditAction.PAYMENT_AUTHORIZED,
        entityType: AuditEntity.PAYMENT,
        entityId: String(updated._id),
        organizationId: updated.organizationId ?? null,
        metadata: {
          orderNumber: updated.orderNumber,
          amountAuthorized,
          currency: updated.pricing.currency,
          paymentIntentId: input.paymentIntentId,
          eventId: input.eventId,
          source: input.source,
        },
      },
      session,
    );

    await captureEvidenceSafe(
      {
        orderId: String(updated._id),
        orderNumber: updated.orderNumber,
        eventType: OrderEvidenceEventType.PAYMENT_AUTHORIZED,
        occurredAt: authorizedAt,
        actor: { type: OrderEvidenceActorType.GATEWAY, name: input.source },
        payload: {
          gateway: updated.payment.gateway ?? null,
          gatewayEventId: input.eventId,
          paymentIntentId: input.paymentIntentId ?? null,
          amountAuthorized,
          currency: updated.pricing.currency,
          authorizedAt: authorizedAt.toISOString(),
          captureExpiresAt:
            updated.payment.capture?.captureExpiresAt?.toISOString() ?? null,
          bookingStatus: BookingStatus.PENDING,
          note: "Funds are held, not captured. No money has moved.",
          source: input.source,
        },
        refs: {
          gatewayEventId: input.eventId,
          paymentIntentId: input.paymentIntentId ?? null,
          transactionId: input.paymentIntentId ?? null,
          customerEmail: updated.customer.email,
        },
      },
      session,
    );

    // Tell the customer their card was AUTHORIZED — explicitly not
    // charged. Enqueued in-transaction so it cannot land if the order
    // update aborts. Only manual-capture orders ever reach this line, so
    // neither incumbent brand can produce such a row.
    await enqueueEmail(
      {
        orderId: String(updated._id),
        kind: EmailKind.PAYMENT_AUTHORIZED,
        recipient: updated.customer.email,
      },
      session,
    );

    return { duplicate: false, updated };
  });

  if (outcome.duplicate) {
    await recordAudit({
      action: AuditAction.WEBHOOK_DUPLICATE,
      entityType: AuditEntity.WEBHOOK,
      entityId: input.eventId,
      organizationId: order.organizationId ?? null,
      metadata: { orderId: String(order._id), source: input.source },
    });
    return { handled: true, duplicate: true, orderId: String(order._id) };
  }

  logger.info("order.lifecycle.transition", {
    orderId: String(outcome.updated._id),
    orderNumber: outcome.updated.orderNumber,
    previousState: PaymentCaptureStatus.PENDING_AUTHORIZATION,
    nextState: PaymentCaptureStatus.AUTHORIZED,
    transition: "authorized",
    source: `service.webhook.${input.source}`,
    eventId: input.eventId,
  });
  publishEvent({
    type: DomainEventType.ORDER_AUTHORIZED,
    audience: {
      kind: "creator",
      userId: String(outcome.updated.createdBy.userId),
    },
    payload: {
      orderId: String(outcome.updated._id),
      orderNumber: outcome.updated.orderNumber,
      amountAuthorized: outcome.updated.payment.capture?.amountAuthorized ?? 0,
      currency: outcome.updated.pricing.currency,
      customerName: outcome.updated.customer.name,
    },
  });
  kickPostCommitDrain();

  return {
    handled: true,
    duplicate: false,
    orderId: String(outcome.updated._id),
  };
}

/**
 * `payment_intent.amount_capturable_updated`, or a
 * `checkout.session.completed` that the adapter rerouted because the
 * session reported `payment_status: "unpaid"`.
 *
 * Stripe emits `amount_capturable_updated` ONLY under manual capture, so
 * an automatic-capture organization's traffic never reaches this handler.
 * The order-level guard below is belt-and-braces on top of that.
 */
async function handlePaymentAuthorized(
  event: VerifiedPaymentEvent,
  endpointOrgId: string | null,
): Promise<ProcessEventResult> {
  const order = await findOrderForEndpoint(event, endpointOrgId);
  if (!order) {
    logger.warn("payments.order_not_found_for_authorization", {
      sessionId: event.sessionId,
      paymentIntentId: event.paymentIntentId,
    });
    return { handled: false, duplicate: false, reason: "order_not_found" };
  }

  // Decided by the ORDER's own stored capture method, not by anything in
  // the payload and not by which organization we think this is. An order
  // that is not manual-capture is left completely untouched.
  if (order.payment?.capture?.method !== CaptureMode.MANUAL) {
    logger.warn("payments.authorization_on_non_manual_order", {
      orderId: String(order._id),
      eventId: event.eventId,
    });
    return { handled: false, duplicate: false, reason: "not_manual_capture" };
  }

  return applyPaymentAuthorized(order, {
    eventId: event.eventId,
    paymentIntentId: event.paymentIntentId,
    amountAuthorizedMinor:
      event.authorization?.amountCapturableMinor ?? event.amountTotalMinor,
    authorizedAtMs: event.occurredAtMs,
    source: "webhook",
  });
}

/**
 * `payment_intent.succeeded` on a manual-capture intent — the hold became
 * a real charge.
 *
 * The adapter maps this event to `payment.captured` ONLY when the intent
 * reports `capture_method: "manual"`, so an automatic-capture order's
 * `payment_intent.succeeded` stays "unhandled" exactly as it is today and
 * the moment RentalConfirmation's orders are marked paid does not move.
 *
 * The PAID transition itself reuses `applyCheckoutPaid` UNCHANGED, so the
 * audit row, the evidence entry, the ORDER_PAID domain event and the
 * single-confirmation-email guarantee are identical across all brands.
 */
async function handlePaymentCaptured(
  event: VerifiedPaymentEvent,
  endpointOrgId: string | null,
): Promise<ProcessEventResult> {
  const order = await findOrderForEndpoint(event, endpointOrgId);
  if (!order) {
    return { handled: false, duplicate: false, reason: "order_not_found" };
  }
  if (order.payment?.capture?.method !== CaptureMode.MANUAL) {
    return { handled: false, duplicate: false, reason: "not_manual_capture" };
  }

  const capturedAtMs = event.occurredAtMs;
  const amountMinor =
    event.authorization?.amountReceivedMinor ?? event.amountTotalMinor;

  const result = await applyCheckoutPaid(order, {
    eventId: event.eventId,
    sessionId: event.sessionId ?? order.payment.stripeSessionId ?? "",
    paymentIntentId: event.paymentIntentId,
    amountTotal: amountMinor,
    paidAtMs: capturedAtMs,
    source: "webhook",
  });

  // Capture bookkeeping + booking confirmation, applied after the money
  // transition. Idempotent by filter: a replay finds the status already
  // CAPTURED and matches nothing.
  await Order.updateOne(
    {
      _id: order._id,
      "payment.capture.status": {
        $in: [
          PaymentCaptureStatus.AUTHORIZED,
          PaymentCaptureStatus.CAPTURE_PENDING,
          PaymentCaptureStatus.PENDING_AUTHORIZATION,
        ],
      },
    },
    {
      $set: {
        "payment.capture.status": PaymentCaptureStatus.CAPTURED,
        "payment.capture.capturedAt": new Date(capturedAtMs),
        "payment.capture.amountCaptured":
          typeof amountMinor === "number"
            ? amountMinor / 100
            : order.pricing.amount,
        "payment.capture.lastError": null,
        bookingStatus: BookingStatus.CONFIRMED,
      },
    },
  );

  await captureEvidenceSafe({
    orderId: String(order._id),
    orderNumber: order.orderNumber,
    eventType: OrderEvidenceEventType.PAYMENT_CAPTURED,
    occurredAt: new Date(capturedAtMs),
    actor: { type: OrderEvidenceActorType.GATEWAY, name: "webhook" },
    payload: {
      gatewayEventId: event.eventId,
      paymentIntentId: event.paymentIntentId ?? null,
      amountCaptured:
        typeof amountMinor === "number" ? amountMinor / 100 : null,
      currency: order.pricing.currency,
      bookingStatus: BookingStatus.CONFIRMED,
    },
    refs: {
      gatewayEventId: event.eventId,
      paymentIntentId: event.paymentIntentId ?? null,
      customerEmail: order.customer.email,
    },
  });

  return result;
}

/**
 * `payment_intent.canceled` on a manual-capture intent — the hold was
 * released without ever being charged.
 *
 * Two distinct causes, distinguished by Stripe's `cancellation_reason`:
 * an operator released it deliberately, or Stripe released it because it
 * aged out (~7 days). The second is why this handler matters at all — with
 * no scheduler in this codebase, a lapsed authorization would otherwise be
 * completely silent and an operator would keep believing funds were held.
 *
 * `status` / `payment.status` are NOT driven to FAILED: a released hold is
 * not a failed payment, and marking it so would put the order in a terminal
 * state that blocks re-initiating.
 */
async function handlePaymentCancelled(
  event: VerifiedPaymentEvent,
  endpointOrgId: string | null,
): Promise<ProcessEventResult> {
  const order = await findOrderForEndpoint(event, endpointOrgId);
  if (!order) {
    return { handled: false, duplicate: false, reason: "order_not_found" };
  }
  if (order.payment?.capture?.method !== CaptureMode.MANUAL) {
    return { handled: false, duplicate: false, reason: "not_manual_capture" };
  }

  const reason = event.authorization?.cancellationReason ?? null;
  const expired = reason === "automatic" || reason === "abandoned";
  const nextStatus = expired
    ? PaymentCaptureStatus.AUTHORIZATION_EXPIRED
    : PaymentCaptureStatus.CANCELLED;
  const cancelledAt = new Date(event.occurredAtMs);

  const outcome = await withTx(async (session) => {
    const claimed = await tryClaimGatewayEvent(
      {
        gatewayEventId: event.eventId,
        gateway: order.payment.gateway ?? "STRIPE",
        orderId: String(order._id),
      },
      session,
    );
    if (!claimed) return { duplicate: true as const };

    const updated = await Order.findOneAndUpdate(
      {
        _id: order._id,
        "payment.capture.status": {
          $in: [
            PaymentCaptureStatus.PENDING_AUTHORIZATION,
            PaymentCaptureStatus.AUTHORIZED,
            PaymentCaptureStatus.CAPTURE_PENDING,
            PaymentCaptureStatus.CAPTURE_FAILED,
          ],
        },
      },
      {
        $set: {
          "payment.capture.status": nextStatus,
          "payment.capture.cancelledAt": cancelledAt,
          "payment.capture.cancelReason": reason,
          bookingStatus: BookingStatus.CANCELLED,
        },
      },
      { ...sessionOpt(session), returnDocument: "after" },
    ).lean<OrderDoc & { _id: Types.ObjectId }>();

    if (!updated) return { duplicate: true as const };

    await recordAudit(
      {
        action: AuditAction.AUTHORIZATION_RELEASED,
        entityType: AuditEntity.PAYMENT,
        entityId: String(updated._id),
        organizationId: updated.organizationId ?? null,
        metadata: {
          orderNumber: updated.orderNumber,
          captureStatus: nextStatus,
          cancellationReason: reason,
          eventId: event.eventId,
          releasedBy: expired ? "gateway" : "operator_or_gateway",
        },
      },
      session,
    );

    await captureEvidenceSafe(
      {
        orderId: String(updated._id),
        orderNumber: updated.orderNumber,
        eventType: OrderEvidenceEventType.AUTHORIZATION_RELEASED,
        occurredAt: cancelledAt,
        actor: { type: OrderEvidenceActorType.GATEWAY, name: "webhook" },
        payload: {
          gatewayEventId: event.eventId,
          paymentIntentId: event.paymentIntentId ?? null,
          captureStatus: nextStatus,
          cancellationReason: reason,
          bookingStatus: BookingStatus.CANCELLED,
          note: expired
            ? "The gateway released the hold because it was never captured."
            : "The authorization was released without capturing.",
        },
        refs: {
          gatewayEventId: event.eventId,
          paymentIntentId: event.paymentIntentId ?? null,
          customerEmail: updated.customer.email,
        },
      },
      session,
    );

    return { duplicate: false as const, updated };
  });

  if (outcome.duplicate) {
    return { handled: true, duplicate: true, orderId: String(order._id) };
  }

  publishEvent({
    type: DomainEventType.ORDER_AUTHORIZATION_RELEASED,
    audience: {
      kind: "creator",
      userId: String(outcome.updated.createdBy.userId),
    },
    payload: {
      orderId: String(outcome.updated._id),
      orderNumber: outcome.updated.orderNumber,
      captureStatus: nextStatus,
      customerName: outcome.updated.customer.name,
    },
  });

  return {
    handled: true,
    duplicate: false,
    orderId: String(outcome.updated._id),
  };
}

/* ──────────────────────── Dispute + refund handlers ────────────────────── */

/**
 * Find the order targeted by a dispute / refund event. We never receive
 * `client_reference_id` on these — the lookup chain is:
 *   1. metadata.orderId (charge metadata, if the gateway forwarded it)
 *   2. payment.paymentIntentId — both Dispute and Charge carry the PI id
 *
 * Returns null if neither match (e.g. dispute on a charge created
 * outside this platform, or before we stored the PI id).
 */
async function findOrderByPaymentIntent(
  event: VerifiedPaymentEvent,
  expectedOrganizationId: string | null,
): Promise<OrderDocument | null> {
  const found = await (async (): Promise<OrderDocument | null> => {
    if (event.orderId && Types.ObjectId.isValid(event.orderId)) {
      const direct = await Order.findById(event.orderId);
      if (direct) return direct;
    }
    if (event.paymentIntentId) {
      const byIntent = await Order.findOne({
        "payment.paymentIntentId": event.paymentIntentId,
      });
      if (byIntent) return byIntent;
    }
    return null;
  })();
  if (!found) return null;

  // THE SAME CROSS-ORGANIZATION RULE THE PAYMENT HANDLERS OBEY.
  //
  // This path used to skip it, which meant a `charge.dispute.*` or
  // `charge.refunded` delivered to one brand's endpoint could mutate
  // ANOTHER brand's order — its dispute pointer, its risk flag, its
  // refunded total — purely because the payload carried that order's
  // payment-intent id.
  //
  // Behaviour for the incumbents is unchanged: the deployment-level
  // endpoint passes a null organization, and the rule for null is "the
  // default organization's orders plus unattributed pre-migration ones",
  // which is exactly what RentalConfirmation's disputes are.
  if (await orderBelongsToEndpoint(found, expectedOrganizationId)) return found;

  logger.error("payments.cross_organization_event", {
    eventId: event.eventId,
    type: event.type,
    orderId: String(found._id),
    orderOrganizationId: found.organizationId
      ? String(found.organizationId)
      : null,
    endpointOrganizationId: expectedOrganizationId,
  });
  await recordAudit({
    action: AuditAction.WEBHOOK_FAILED,
    entityType: AuditEntity.WEBHOOK,
    entityId: event.eventId,
    metadata: {
      reason: "cross_organization_event",
      type: event.type,
      orderId: String(found._id),
      orderOrganizationId: found.organizationId
        ? String(found.organizationId)
        : null,
      endpointOrganizationId: expectedOrganizationId,
    },
  });
  return null;
}

/**
 * A dispute row may only be mutated by the endpoint of the organization
 * that owns it.
 *
 * `dispute.updated`, `dispute.closed` and `dispute.funds_withdrawn` resolve
 * their target by `gatewayDisputeId` alone, which is a value the PAYLOAD
 * supplies — so without this check a delivery to one brand's endpoint could
 * drive another brand's chargeback to WON/LOST, move its risk flag, and
 * write to its audit trail. `dispute.created` and `refund.created` already
 * go through `findOrderByPaymentIntent`, which enforces the same rule.
 *
 * The rule is identical to the order-level one: a null-organization row —
 * every dispute written before this change — belongs to the DEFAULT
 * organization, which is what RentalConfirmation's disputes already are, so
 * the deployment-level endpoint keeps resolving them exactly as it does now.
 */
async function disputeBelongsToEndpoint(
  dispute: { organizationId?: Types.ObjectId | null; orderId?: Types.ObjectId },
  expectedOrganizationId: string | null,
): Promise<boolean> {
  const disputeOrg = dispute.organizationId
    ? String(dispute.organizationId)
    : null;

  // Prefer the dispute's own stamp; fall back to the order it points at, so
  // a pre-change dispute row with no stamp is still resolved correctly
  // rather than being lumped in with the default organization by accident.
  const owningOrg = await (async () => {
    if (disputeOrg) return disputeOrg;
    if (!dispute.orderId) return null;
    const order = await Order.findById(dispute.orderId)
      .select("organizationId")
      .lean<{ organizationId?: Types.ObjectId | null } | null>();
    return order?.organizationId ? String(order.organizationId) : null;
  })();

  if (expectedOrganizationId) return owningOrg === expectedOrganizationId;
  if (owningOrg === null) return true; // pre-migration row
  const def = await Organization.findOne({ isDefault: true })
    .select("_id")
    .lean<{ _id: unknown } | null>();
  return Boolean(def && String(def._id) === owningOrg);
}

/** Log + audit a refused cross-organization dispute mutation. */
async function refuseCrossOrgDispute(
  event: VerifiedPaymentEvent,
  disputeId: string,
  expectedOrganizationId: string | null,
): Promise<ProcessEventResult> {
  logger.error("payments.cross_organization_event", {
    eventId: event.eventId,
    type: event.type,
    gatewayDisputeId: disputeId,
    endpointOrganizationId: expectedOrganizationId,
  });
  await recordAudit({
    action: AuditAction.WEBHOOK_FAILED,
    entityType: AuditEntity.WEBHOOK,
    entityId: event.eventId,
    metadata: {
      reason: "cross_organization_event",
      type: event.type,
      gatewayDisputeId: disputeId,
      endpointOrganizationId: expectedOrganizationId,
    },
  });
  return { handled: false, duplicate: false, reason: "order_not_found" };
}

async function handleDisputeCreated(
  event: VerifiedPaymentEvent,
  endpointOrgId: string | null,
): Promise<ProcessEventResult> {
  const d = event.dispute;
  if (!d) {
    return { handled: false, duplicate: false, reason: "missing_dispute_payload" };
  }
  const order = await findOrderByPaymentIntent(event, endpointOrgId);
  if (!order) {
    logger.warn("payments.dispute.order_not_found", {
      disputeId: d.gatewayDisputeId,
      paymentIntentId: event.paymentIntentId,
    });
    return { handled: false, duplicate: false, reason: "order_not_found" };
  }

  const gatewayKey = order.payment.gateway ?? "STRIPE";

  type Outcome =
    | { duplicate: true }
    | {
        duplicate: false;
        dispute: DisputeDoc & { _id: Types.ObjectId };
      };

  const outcome: Outcome = await withTx(async (session) => {
    // Primary dedupe — durable, collection-backed.
    const claimed = await tryClaimGatewayEvent(
      {
        gatewayEventId: event.eventId,
        gateway: gatewayKey,
        orderId: String(order._id),
      },
      session,
    );
    if (!claimed) return { duplicate: true };

    // Defensive: still check the per-dispute eventId array for in-flight
    // races against pre-tx code paths.
    const existingQuery = Dispute.findOne({
      gatewayDisputeId: d.gatewayDisputeId,
    });
    const existing = await (session
      ? existingQuery.session(session)
      : existingQuery);

    const amountMinor = d.amountMinor ?? 0;
    const amount =
      amountMinor > 0 ? amountMinor / 100 : order.pricing.amount;
    const currency = (d.currency ?? order.pricing.currency) as
      OrderDoc["pricing"]["currency"];

    let dispute: DisputeDoc & { _id: Types.ObjectId };
    if (existing) {
      existing.status = d.status as DisputeStatus;
      existing.reason = d.reason ?? existing.reason;
      existing.evidenceDueAt = d.evidenceDueByMs
        ? new Date(d.evidenceDueByMs)
        : existing.evidenceDueAt;
      existing.amount = amount;
      existing.amountMinor = amountMinor;
      existing.processedWebhookEventIds.push(event.eventId);
      await existing.save(sessionOpt(session));
      dispute = existing.toObject({ getters: false }) as DisputeDoc & {
        _id: Types.ObjectId;
      };
    } else {
      const created = await Dispute.create(
        [
          {
            orderId: order._id,
            orderNumber: order.orderNumber,
            // Stamped from the RESOLVED ORDER, exactly as evidence.service
            // already does. Webhook-written rows used to carry no
            // organization at all, and a null-org row is visible only to
            // the DEFAULT organization — so a non-default tenant could not
            // see its own chargebacks while RentalConfirmation saw them
            // all. Null here still means "the default organization's",
            // which is what RentalConfirmation's disputes already are, so
            // nothing changes for the incumbents.
            organizationId: order.organizationId ?? null,
            gateway: gatewayKey,
            gatewayDisputeId: d.gatewayDisputeId,
            chargeId: d.chargeId,
            paymentIntentId: event.paymentIntentId,
            status: d.status as DisputeStatus,
            reason: d.reason,
            outcome: null,
            amount,
            amountMinor,
            currency,
            evidenceDueAt: d.evidenceDueByMs ? new Date(d.evidenceDueByMs) : null,
            openedAt: new Date(event.occurredAtMs),
            processedWebhookEventIds: [event.eventId],
          },
        ],
        sessionOpt(session),
      );
      dispute = (created[0] as unknown as {
        toObject: (opts?: { getters?: boolean }) => DisputeDoc & {
          _id: Types.ObjectId;
        };
      }).toObject({ getters: false });
    }

    await Order.updateOne(
      { _id: order._id },
      {
        $set: {
          dispute: {
            status: dispute.status,
            currentDisputeId: dispute._id,
            openedAt: dispute.openedAt,
            closedAt: null,
            outcome: null,
            reason: dispute.reason,
            amount: dispute.amount,
            currency: dispute.currency,
          },
          "risk.flagged": true,
          "risk.flaggedAt": new Date(event.occurredAtMs),
          "risk.flaggedNote": dispute.reason
            ? `Chargeback opened: ${dispute.reason}`
            : "Chargeback opened",
          "risk.flaggedBy": {
            userId: null,
            name: `${gatewayKey} webhook`,
          },
        },
      },
      sessionOpt(session),
    );

    await recordAudit(
      {
        action: AuditAction.DISPUTE_CREATED,
        entityType: AuditEntity.DISPUTE,
        entityId: String(dispute._id),
        // Attribute the row to the order's tenant. Webhook deliveries carry no
        // request scope, so without this the row is written unattributed — and
        // a null-organization audit row is visible ONLY to the default
        // organization, hiding a brand's own payment trail from it.
        organizationId: dispute.organizationId ?? order.organizationId ?? null,
        metadata: {
          orderId: String(order._id),
          orderNumber: order.orderNumber,
          gatewayDisputeId: dispute.gatewayDisputeId,
          reason: dispute.reason,
          amount: dispute.amount,
          currency: dispute.currency,
          eventId: event.eventId,
        },
      },
      session,
    );

    await captureEvidenceSafe(
      {
        orderId: String(order._id),
        orderNumber: order.orderNumber,
        eventType: OrderEvidenceEventType.PAYMENT_FAILED,
        occurredAt: new Date(event.occurredAtMs),
        actor: { type: OrderEvidenceActorType.GATEWAY, name: "stripe.webhook" },
        payload: {
          kind: "dispute_created",
          disputeId: String(dispute._id),
          gatewayDisputeId: dispute.gatewayDisputeId,
          status: dispute.status,
          reason: dispute.reason,
          amount: dispute.amount,
          currency: dispute.currency,
        },
      },
      session,
    );

    return { duplicate: false, dispute };
  });

  if (outcome.duplicate) {
    await recordAudit({
      action: AuditAction.WEBHOOK_DUPLICATE,
      entityType: AuditEntity.WEBHOOK,
      entityId: event.eventId,
      metadata: { source: "dispute.created" },
    });
    return { handled: true, duplicate: true, orderId: String(order._id) };
  }

  logger.info("order.lifecycle.transition", {
    orderId: String(order._id),
    orderNumber: order.orderNumber,
    previousState: order.status,
    nextState: order.status,
    transition: "dispute_created",
    source: "service.webhook.dispute_created",
    eventId: event.eventId,
    disputeId: String(outcome.dispute._id),
  });
  publishEvent({
    type: DomainEventType.ORDER_DISPUTE_CREATED,
    audience: { kind: "creator", userId: String(order.createdBy.userId) },
    payload: {
      orderId: String(order._id),
      orderNumber: order.orderNumber,
      customerName: order.customer.name,
      disputeId: String(outcome.dispute._id),
      status: outcome.dispute.status,
      reason: outcome.dispute.reason,
      amount: outcome.dispute.amount,
      currency: outcome.dispute.currency,
    },
  });

  return { handled: true, duplicate: false, orderId: String(order._id) };
}

async function handleDisputeUpdated(
  event: VerifiedPaymentEvent,
  endpointOrgId: string | null,
): Promise<ProcessEventResult> {
  const d = event.dispute;
  if (!d) {
    return { handled: false, duplicate: false, reason: "missing_dispute_payload" };
  }
  const dispute = await Dispute.findOne({
    gatewayDisputeId: d.gatewayDisputeId,
  });
  if (dispute && !(await disputeBelongsToEndpoint(dispute, endpointOrgId))) {
    return refuseCrossOrgDispute(event, d.gatewayDisputeId, endpointOrgId);
  }
  if (!dispute) {
    // Update arrived before created — rare but possible if Stripe retried
    // out of order. Treat as a create and let that handler reconcile.
    return handleDisputeCreated(event, endpointOrgId);
  }

  type Outcome =
    | { duplicate: true }
    | { duplicate: false; status: DisputeStatus };

  const outcome: Outcome = await withTx(async (session) => {
    const claimed = await tryClaimGatewayEvent(
      {
        gatewayEventId: event.eventId,
        gateway: dispute.gateway ?? "STRIPE",
        orderId: String(dispute.orderId),
      },
      session,
    );
    if (!claimed) return { duplicate: true };

    dispute.status = d.status as DisputeStatus;
    dispute.reason = d.reason ?? dispute.reason;
    dispute.evidenceDueAt = d.evidenceDueByMs
      ? new Date(d.evidenceDueByMs)
      : dispute.evidenceDueAt;
    dispute.processedWebhookEventIds.push(event.eventId);
    await dispute.save(sessionOpt(session));

    await Order.updateOne(
      { _id: dispute.orderId },
      {
        $set: {
          "dispute.status": dispute.status,
          "dispute.reason": dispute.reason,
        },
      },
      sessionOpt(session),
    );

    await recordAudit(
      {
        action: AuditAction.DISPUTE_UPDATED,
        entityType: AuditEntity.DISPUTE,
        entityId: String(dispute._id),
        // Attribute the row to the order's tenant. Webhook deliveries carry no
        // request scope, so without this the row is written unattributed — and
        // a null-organization audit row is visible ONLY to the default
        // organization, hiding a brand's own payment trail from it.
        organizationId: dispute.organizationId ?? null,
        metadata: {
          orderId: String(dispute.orderId),
          orderNumber: dispute.orderNumber,
          status: dispute.status,
          eventId: event.eventId,
        },
      },
      session,
    );

    return { duplicate: false, status: dispute.status as DisputeStatus };
  });

  if (outcome.duplicate) {
    return {
      handled: true,
      duplicate: true,
      orderId: String(dispute.orderId),
    };
  }

  publishEvent({
    type: DomainEventType.ORDER_DISPUTE_UPDATED,
    audience: { kind: "admins" },
    payload: {
      orderId: String(dispute.orderId),
      orderNumber: dispute.orderNumber,
      disputeId: String(dispute._id),
      status: outcome.status,
    },
  });

  return {
    handled: true,
    duplicate: false,
    orderId: String(dispute.orderId),
  };
}

async function handleDisputeClosed(
  event: VerifiedPaymentEvent,
  endpointOrgId: string | null,
): Promise<ProcessEventResult> {
  const d = event.dispute;
  if (!d) {
    return { handled: false, duplicate: false, reason: "missing_dispute_payload" };
  }
  let dispute = await Dispute.findOne({
    gatewayDisputeId: d.gatewayDisputeId,
  });
  if (dispute && !(await disputeBelongsToEndpoint(dispute, endpointOrgId))) {
    return refuseCrossOrgDispute(event, d.gatewayDisputeId, endpointOrgId);
  }
  let materialisedDuringClose = false;
  if (!dispute) {
    // Closed before we saw created. Materialise it now so the audit
    // trail isn't lost — then apply the close on top. The created
    // handler will register this event-id on the new dispute; we strip
    // it back off so the close transition below isn't treated as a
    // duplicate of itself.
    await handleDisputeCreated(event, endpointOrgId);
    dispute = await Dispute.findOne({
      gatewayDisputeId: d.gatewayDisputeId,
    });
    if (!dispute) {
      return { handled: false, duplicate: false, reason: "order_not_found" };
    }
    materialisedDuringClose = true;
    dispute.processedWebhookEventIds = dispute.processedWebhookEventIds.filter(
      (id) => id !== event.eventId,
    );
  }
  if (
    !materialisedDuringClose &&
    dispute.processedWebhookEventIds.includes(event.eventId)
  ) {
    return {
      handled: true,
      duplicate: true,
      orderId: String(dispute.orderId),
    };
  }

  const closedAt = new Date(event.occurredAtMs);

  type Outcome =
    | { duplicate: true }
    | { duplicate: false };

  const outcome: Outcome = await withTx(async (session) => {
    // When `materialisedDuringClose` is true the `handleDisputeCreated`
    // call above already inserted a ProcessedWebhookEvent row for this
    // event id — that's the "we created the dispute from a close" race.
    // Try-claim is idempotent (returns false if already claimed) so this
    // branch correctly falls through without re-applying anything new.
    if (!materialisedDuringClose) {
      const claimed = await tryClaimGatewayEvent(
        {
          gatewayEventId: event.eventId,
          gateway: dispute.gateway ?? "STRIPE",
          orderId: String(dispute.orderId),
        },
        session,
      );
      if (!claimed) return { duplicate: true };
    }

    dispute.status = d.status as DisputeStatus;
    dispute.outcome = (d.outcome ?? null) as DisputeDoc["outcome"];
    dispute.closedAt = closedAt;
    dispute.processedWebhookEventIds.push(event.eventId);
    await dispute.save(sessionOpt(session));

    await Order.updateOne(
      { _id: dispute.orderId },
      {
        $set: {
          "dispute.status": dispute.status,
          "dispute.closedAt": closedAt,
          "dispute.outcome": dispute.outcome,
        },
      },
      sessionOpt(session),
    );

    await recordAudit(
      {
        action: AuditAction.DISPUTE_CLOSED,
        entityType: AuditEntity.DISPUTE,
        entityId: String(dispute._id),
        // Attribute the row to the order's tenant. Webhook deliveries carry no
        // request scope, so without this the row is written unattributed — and
        // a null-organization audit row is visible ONLY to the default
        // organization, hiding a brand's own payment trail from it.
        organizationId: dispute.organizationId ?? null,
        metadata: {
          orderId: String(dispute.orderId),
          orderNumber: dispute.orderNumber,
          outcome: dispute.outcome,
          status: dispute.status,
          eventId: event.eventId,
        },
      },
      session,
    );

    return { duplicate: false };
  });

  if (outcome.duplicate) {
    return {
      handled: true,
      duplicate: true,
      orderId: String(dispute.orderId),
    };
  }

  publishEvent({
    type: DomainEventType.ORDER_DISPUTE_CLOSED,
    audience: { kind: "admins" },
    payload: {
      orderId: String(dispute.orderId),
      orderNumber: dispute.orderNumber,
      disputeId: String(dispute._id),
      outcome: dispute.outcome,
      status: dispute.status,
    },
  });

  return {
    handled: true,
    duplicate: false,
    orderId: String(dispute.orderId),
  };
}

async function handleDisputeFundsWithdrawn(
  event: VerifiedPaymentEvent,
  endpointOrgId: string | null,
): Promise<ProcessEventResult> {
  const d = event.dispute;
  if (!d) {
    return { handled: false, duplicate: false, reason: "missing_dispute_payload" };
  }
  const dispute = await Dispute.findOne({
    gatewayDisputeId: d.gatewayDisputeId,
  });
  if (dispute && !(await disputeBelongsToEndpoint(dispute, endpointOrgId))) {
    return refuseCrossOrgDispute(event, d.gatewayDisputeId, endpointOrgId);
  }
  if (!dispute) {
    return { handled: false, duplicate: false, reason: "dispute_not_found" };
  }
  const fwOutcome: { duplicate: boolean } = await withTx(async (session) => {
    const claimed = await tryClaimGatewayEvent(
      {
        gatewayEventId: event.eventId,
        gateway: dispute.gateway ?? "STRIPE",
        orderId: String(dispute.orderId),
      },
      session,
    );
    if (!claimed) return { duplicate: true };

    dispute.processedWebhookEventIds.push(event.eventId);
    await dispute.save(sessionOpt(session));

    await recordAudit(
      {
        action: AuditAction.DISPUTE_FUNDS_WITHDRAWN,
        entityType: AuditEntity.DISPUTE,
        entityId: String(dispute._id),
        // Attribute the row to the order's tenant. Webhook deliveries carry no
        // request scope, so without this the row is written unattributed — and
        // a null-organization audit row is visible ONLY to the default
        // organization, hiding a brand's own payment trail from it.
        organizationId: dispute.organizationId ?? null,
        metadata: {
          orderId: String(dispute.orderId),
          orderNumber: dispute.orderNumber,
          amount: dispute.amount,
          currency: dispute.currency,
          eventId: event.eventId,
        },
      },
      session,
    );

    return { duplicate: false };
  });

  if (fwOutcome.duplicate) {
    return {
      handled: true,
      duplicate: true,
      orderId: String(dispute.orderId),
    };
  }

  // Re-use the dispute_updated push so the UI invalidates and surfaces
  // any balance-impact copy. No separate domain event type for now —
  // operators care more about created/closed.
  publishEvent({
    type: DomainEventType.ORDER_DISPUTE_UPDATED,
    audience: { kind: "admins" },
    payload: {
      orderId: String(dispute.orderId),
      orderNumber: dispute.orderNumber,
      disputeId: String(dispute._id),
      status: dispute.status,
      fundsWithdrawn: true,
    },
  });

  return {
    handled: true,
    duplicate: false,
    orderId: String(dispute.orderId),
  };
}

async function handleRefundCreated(
  event: VerifiedPaymentEvent,
  endpointOrgId: string | null,
): Promise<ProcessEventResult> {
  const r = event.refund;
  if (!r) {
    return { handled: false, duplicate: false, reason: "missing_refund_payload" };
  }
  const order = await findOrderByPaymentIntent(event, endpointOrgId);
  if (!order) {
    logger.warn("payments.refund.order_not_found", {
      refundId: r.gatewayRefundId,
      paymentIntentId: event.paymentIntentId,
    });
    return { handled: false, duplicate: false, reason: "order_not_found" };
  }

  const gatewayKey = order.payment.gateway ?? "STRIPE";
  const totalRefundedMinor = r.amountRefundedTotalMinor ?? r.amountMinor ?? 0;
  const totalRefunded = totalRefundedMinor / 100;
  const eventAmount = (r.amountMinor ?? 0) / 100;

  type Outcome =
    | { duplicate: true }
    | { duplicate: false; updated: OrderDoc & { _id: Types.ObjectId } };

  const outcome: Outcome = await withTx(async (session) => {
    const claimed = await tryClaimGatewayEvent(
      {
        gatewayEventId: event.eventId,
        gateway: gatewayKey,
        orderId: String(order._id),
      },
      session,
    );
    if (!claimed) return { duplicate: true };

    const updated = await Order.findOneAndUpdate(
      {
        _id: order._id,
        "payment.processedWebhookEventIds": { $ne: event.eventId },
      },
      {
        $set: {
          refundedAmount: Math.max(
            order.refundedAmount ?? 0,
            totalRefunded,
          ),
        },
        $push: {
          "payment.processedWebhookEventIds": {
            $each: [event.eventId],
            $slice: -50,
          },
        },
      },
      { ...sessionOpt(session), returnDocument: "after" },
    ).lean<OrderDoc & { _id: Types.ObjectId }>();
    if (!updated) return { duplicate: true };

    await recordAudit(
      {
        action: AuditAction.REFUND_CREATED,
        entityType: AuditEntity.PAYMENT,
        entityId: String(updated._id),
        // Attribute the row to the order's tenant. Webhook deliveries carry no
        // request scope, so without this the row is written unattributed — and
        // a null-organization audit row is visible ONLY to the default
        // organization, hiding a brand's own payment trail from it.
        organizationId: updated.organizationId ?? null,
        metadata: {
          orderId: String(updated._id),
          orderNumber: updated.orderNumber,
          gatewayRefundId: r.gatewayRefundId,
          amount: eventAmount,
          totalRefunded,
          currency: updated.pricing.currency,
          eventId: event.eventId,
        },
      },
      session,
    );

    await captureEvidenceSafe(
      {
        orderId: String(updated._id),
        orderNumber: updated.orderNumber,
        eventType: OrderEvidenceEventType.REFUND_ISSUED,
        occurredAt: new Date(event.occurredAtMs),
        actor: { type: OrderEvidenceActorType.GATEWAY, name: "stripe.webhook" },
        payload: {
          gatewayRefundId: r.gatewayRefundId,
          amount: eventAmount,
          totalRefunded,
          currency: updated.pricing.currency,
        },
      },
      session,
    );

    return { duplicate: false, updated };
  });

  if (outcome.duplicate) {
    return { handled: true, duplicate: true, orderId: String(order._id) };
  }

  publishEvent({
    type: DomainEventType.ORDER_REFUNDED,
    audience: {
      kind: "creator",
      userId: String(outcome.updated.createdBy.userId),
    },
    payload: {
      orderId: String(outcome.updated._id),
      orderNumber: outcome.updated.orderNumber,
      customerName: outcome.updated.customer.name,
      amount: eventAmount,
      totalRefunded,
      currency: outcome.updated.pricing.currency,
    },
  });

  return {
    handled: true,
    duplicate: false,
    orderId: String(outcome.updated._id),
  };
}
