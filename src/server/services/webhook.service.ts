import "server-only";

import { type ClientSession, Types } from "mongoose";

import {
  AuditAction,
  AuditEntity,
  type DisputeStatus,
  EmailKind,
  OrderEvidenceActorType,
  OrderEvidenceEventType,
  OrderStatus,
} from "@/lib/constants/enums";
import { DomainEventType } from "@/lib/constants/events";
import { logger } from "@/lib/logger";
import {
  Dispute,
  type DisputeDoc,
  Order,
  type OrderDoc,
  type OrderDocument,
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
import { getOrCreateDefaultWorkflow } from "./workflow.service";

/** Resolve the order's tenant-configured "payment succeeded" status
 *  key. Defaults to "PAID" for tenants who haven't visited the
 *  workflow builder. Used by the webhook handlers so a tenant that
 *  renamed their paid status to e.g. "SETTLED" still gets correctly
 *  transitioned by Stripe events. */
async function resolvePaymentSuccessStatusKey(
  order: { orgId?: Types.ObjectId | null },
): Promise<string> {
  if (!order.orgId) return "PAID";
  const wf = await getOrCreateDefaultWorkflow(String(order.orgId));
  return wf.paymentSuccessStatusKey;
}

async function resolvePaymentFailureStatusKey(
  order: { orgId?: Types.ObjectId | null },
): Promise<string> {
  if (!order.orgId) return "FAILED";
  const wf = await getOrCreateDefaultWorkflow(String(order.orgId));
  return wf.paymentFailureStatusKey;
}
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
 * Optional scope hint. When supplied by the per-org webhook route, the
 * order-lookup helpers below scope to `orgId` so a Stripe event
 * delivered to org A's URL can never resolve org B's order — even if
 * org B's `paymentIntentId` happens to be the same string (it won't
 * be, since intents are globally unique on Stripe's side, but the
 * scope is still the right semantic boundary).
 *
 * Legacy `/api/webhooks/stripe` route calls without a scope; behaviour
 * is unchanged for Tenant #1.
 */
export interface ProcessEventScope {
  orgId?: string | null;
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
  scope: ProcessEventScope = {},
): Promise<ProcessEventResult> {
  await connectMongo();
  logger.info("payments.event", {
    id: event.eventId,
    type: event.type,
    orgId: scope.orgId ?? undefined,
  });

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
      return handleCheckoutCompleted(event, scope);
    case "checkout.expired":
      return handleCheckoutExpired(event, scope);
    case "checkout.failed":
      return handleCheckoutFailed(event, scope);
    case "payment.failed":
      return handlePaymentFailed(event, scope);
    case "dispute.created":
      return handleDisputeCreated(event, scope);
    case "dispute.updated":
      return handleDisputeUpdated(event, scope);
    case "dispute.closed":
      return handleDisputeClosed(event, scope);
    case "dispute.funds_withdrawn":
      return handleDisputeFundsWithdrawn(event, scope);
    case "refund.created":
      return handleRefundCreated(event, scope);
    case "unhandled":
    default:
      return { handled: false, duplicate: false, reason: "unhandled_event" };
  }
}

/** Back-compat re-export for any caller still on the old name. New code
 *  should import `processGatewayEvent`. */
export const processStripeEvent = processGatewayEvent;

async function findOrderForEvent(
  event: VerifiedPaymentEvent,
  scope: ProcessEventScope = {},
): Promise<OrderDocument | null> {
  // When a scope is supplied by the per-org webhook route, every
  // lookup pins the orgId so a cross-tenant collision can never
  // resolve the wrong order. Without a scope (legacy route) we keep
  // pre-Phase-3 behaviour — Tenant #1's flow unchanged.
  const scopeClause =
    scope.orgId && Types.ObjectId.isValid(scope.orgId)
      ? { orgId: new Types.ObjectId(scope.orgId) }
      : null;

  // Order id round-tripped via the gateway's metadata is the most
  // reliable identifier — it survives session-id rotation and works
  // for events that don't carry a session id.
  if (event.orderId && Types.ObjectId.isValid(event.orderId)) {
    const filter = scopeClause
      ? { _id: new Types.ObjectId(event.orderId), ...scopeClause }
      : { _id: new Types.ObjectId(event.orderId) };
    const direct = await Order.findOne(filter);
    if (direct) return direct;
  }
  if (event.sessionId) {
    const bySession = await Order.findOne({
      "payment.stripeSessionId": event.sessionId,
      ...(scopeClause ?? {}),
    });
    if (bySession) return bySession;
  }
  if (event.paymentIntentId) {
    const byIntent = await Order.findOne({
      "payment.paymentIntentId": event.paymentIntentId,
      ...(scopeClause ?? {}),
    });
    if (byIntent) return byIntent;
  }
  return null;
}

async function handleCheckoutCompleted(
  event: VerifiedPaymentEvent,
  scope: ProcessEventScope = {},
): Promise<ProcessEventResult> {
  const order = await findOrderForEvent(event, scope);
  if (!order) {
    logger.warn("payments.order_not_found_for_session", {
      sessionId: event.sessionId,
    });
    return { handled: false, duplicate: false, reason: "order_not_found" };
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
  // Resolve the tenant's paid-status-key from their workflow. Defaults
  // to "PAID" for tenants who haven't customized — so the existing
  // dashboard rollups + email triggers that key off status === "PAID"
  // keep working until those callers are migrated to read isPaid from
  // the workflow.
  const paidStatusKey = await resolvePaymentSuccessStatusKey(order);

  type TxOutcome =
    | { duplicate: true }
    | {
        duplicate: false;
        didTransition: boolean;
        previousStatus: string;
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

    const isAlreadyPaid = order.status === paidStatusKey;
    const amountReceived =
      typeof input.amountTotal === "number"
        ? input.amountTotal / 100
        : order.pricing.amount;

    // 2. Conditional update — flips current → workflow.paymentSuccess
    // exactly once. The `status: { $ne: paidStatusKey }` guard is the
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
        status: { $ne: paidStatusKey },
        "payment.processedWebhookEventIds": { $ne: input.eventId },
      },
      {
        $set: {
          status: paidStatusKey,
          "payment.status": paidStatusKey,
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
      // Persisted order.orgId is the authoritative tenant key.
      // Null only for pre-migration orders (Tenant #1 backfilled
      // by the Phase 0+1 migration; no other null sources exist).
      orgId: outcome.updated.orgId ? String(outcome.updated.orgId) : null,
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
  scope: ProcessEventScope = {},
): Promise<ProcessEventResult> {
  const order = await findOrderForEvent(event, scope);
  if (!order) {
    return { handled: false, duplicate: false, reason: "order_not_found" };
  }
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
    orgId: outcome.updated.orgId ? String(outcome.updated.orgId) : null,
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
  scope: ProcessEventScope = {},
): Promise<ProcessEventResult> {
  const order = await findOrderForEvent(event, scope);
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
  scope: ProcessEventScope = {},
): Promise<ProcessEventResult> {
  const order = await findOrderForEvent(event, scope);
  if (!order) {
    return { handled: false, duplicate: false, reason: "order_not_found" };
  }
  const reason =
    event.reason ??
    `Payment intent ${event.paymentIntentId ?? "?"} failed`;
  return failOrder(order, event, reason);
}

async function failOrder(
  order: OrderDocument,
  event: VerifiedPaymentEvent,
  reason: string,
): Promise<ProcessEventResult> {
  // Tenant-defined paid + failed status keys. A failed Stripe event for
  // an already-paid order is a duplicate (no rollback). The failure
  // target is whatever the tenant chose as paymentFailureStatusKey.
  const paidStatusKey = await resolvePaymentSuccessStatusKey(order);
  const failedStatusKey = await resolvePaymentFailureStatusKey(order);

  if (order.status === paidStatusKey) {
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
        status: { $ne: paidStatusKey },
        "payment.processedWebhookEventIds": { $ne: event.eventId },
      },
      {
        $set: {
          status: failedStatusKey,
          "payment.status": failedStatusKey,
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
    orgId: outcome.updated.orgId ? String(outcome.updated.orgId) : null,
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
  scope: ProcessEventScope = {},
): Promise<OrderDocument | null> {
  const scopeClause =
    scope.orgId && Types.ObjectId.isValid(scope.orgId)
      ? { orgId: new Types.ObjectId(scope.orgId) }
      : null;
  if (event.orderId && Types.ObjectId.isValid(event.orderId)) {
    const filter = scopeClause
      ? { _id: new Types.ObjectId(event.orderId), ...scopeClause }
      : { _id: new Types.ObjectId(event.orderId) };
    const direct = await Order.findOne(filter);
    if (direct) return direct;
  }
  if (event.paymentIntentId) {
    const byIntent = await Order.findOne({
      "payment.paymentIntentId": event.paymentIntentId,
      ...(scopeClause ?? {}),
    });
    if (byIntent) return byIntent;
  }
  return null;
}

async function handleDisputeCreated(
  event: VerifiedPaymentEvent,
  scope: ProcessEventScope = {},
): Promise<ProcessEventResult> {
  const d = event.dispute;
  if (!d) {
    return { handled: false, duplicate: false, reason: "missing_dispute_payload" };
  }
  const order = await findOrderByPaymentIntent(event, scope);
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
    orgId: order.orgId ? String(order.orgId) : null,
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
  scope: ProcessEventScope = {},
): Promise<ProcessEventResult> {
  const d = event.dispute;
  if (!d) {
    return { handled: false, duplicate: false, reason: "missing_dispute_payload" };
  }
  const dispute = await Dispute.findOne({
    gatewayDisputeId: d.gatewayDisputeId,
  });
  if (!dispute) {
    // Update arrived before created — rare but possible if Stripe retried
    // out of order. Treat as a create and let that handler reconcile.
    return handleDisputeCreated(event, scope);
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
    // Scope passed by the per-org webhook route. For dispute streams
    // we also accept the dispute's stored orgId (if present from a
    // future migration) but the route-level scope is authoritative.
    orgId: scope.orgId ?? null,
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
  scope: ProcessEventScope = {},
): Promise<ProcessEventResult> {
  const d = event.dispute;
  if (!d) {
    return { handled: false, duplicate: false, reason: "missing_dispute_payload" };
  }
  let dispute = await Dispute.findOne({
    gatewayDisputeId: d.gatewayDisputeId,
  });
  let materialisedDuringClose = false;
  if (!dispute) {
    // Closed before we saw created. Materialise it now so the audit
    // trail isn't lost — then apply the close on top. The created
    // handler will register this event-id on the new dispute; we strip
    // it back off so the close transition below isn't treated as a
    // duplicate of itself.
    await handleDisputeCreated(event, scope);
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
    orgId: scope.orgId ?? null,
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
  scope: ProcessEventScope = {},
): Promise<ProcessEventResult> {
  const d = event.dispute;
  if (!d) {
    return { handled: false, duplicate: false, reason: "missing_dispute_payload" };
  }
  const dispute = await Dispute.findOne({
    gatewayDisputeId: d.gatewayDisputeId,
  });
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
    orgId: scope.orgId ?? null,
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
  scope: ProcessEventScope = {},
): Promise<ProcessEventResult> {
  const r = event.refund;
  if (!r) {
    return { handled: false, duplicate: false, reason: "missing_refund_payload" };
  }
  const order = await findOrderByPaymentIntent(event, scope);
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
    orgId: outcome.updated.orgId ? String(outcome.updated.orgId) : null,
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
