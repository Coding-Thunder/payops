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
  PaymentGatewayKey,
  UserRole,
} from "@/lib/constants/enums";
import { DomainEventType } from "@/lib/constants/events";
import { ConflictError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { toMinorUnits } from "@/server/payments/currency";
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
      return handleCheckoutCompleted(event, organizationId);
    case "checkout.expired":
      return handleCheckoutExpired(event, organizationId);
    case "checkout.failed":
      return handleCheckoutFailed(event, organizationId);
    case "payment.failed":
      return handlePaymentFailed(event, organizationId);
    case "dispute.created":
      return handleDisputeCreated(event);
    case "dispute.updated":
      return handleDisputeUpdated(event);
    case "dispute.closed":
      return handleDisputeClosed(event);
    case "dispute.funds_withdrawn":
      return handleDisputeFundsWithdrawn(event);
    case "refund.created":
      return handleRefundCreated(event);
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
function orderBelongsToEndpoint(
  order: OrderDocument,
  endpointOrganizationId: string | null,
): boolean {
  const orderOrg = order.organizationId ? String(order.organizationId) : null;

  // Unattributed rows belong to this deployment. On a single-organization
  // deployment that is simply true; it is also what the scope clause already
  // assumes for the default organization, so refusing them here would make
  // the webhook stricter than every read path and quietly strand any order
  // written before the column was stamped everywhere.
  if (orderOrg === null) return true;

  if (endpointOrganizationId) return orderOrg === endpointOrganizationId;
  return true;
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
  endpointOrganizationId: string | null,
  event: VerifiedPaymentEvent,
): Promise<OrderDocument | null> {
  const order = await findOrderForEvent(event);
  if (!order) return null;
  if (orderBelongsToEndpoint(order, endpointOrganizationId)) return order;

  logger.error("payments.cross_organization_event", {
    eventId: event.eventId,
    type: event.type,
    orderId: String(order._id),
    orderOrganizationId: order.organizationId
      ? String(order.organizationId)
      : null,
    endpointOrganizationId,
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
      endpointOrganizationId,
    },
  });
  // Treated as "not our order": the handler reports order_not_found and the
  // record is left completely untouched.
  return null;
}

async function handleCheckoutCompleted(
  event: VerifiedPaymentEvent,
  /** Organization whose endpoint received this delivery. Threaded rather
   *  than held in module state: two concurrent deliveries in one process
   *  would clobber a shared variable between the write and the read. */
  organizationId: string | null,
): Promise<ProcessEventResult> {
  const order = await findOrderForEndpoint(organizationId, event);
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
  sessionId: string | null;
  paymentIntentId: string | null;
  /** Stripe minor-unit amount. When null we fall back to the order's
   *  pricing.amount — same defensive default the original webhook used. */
  amountTotal: number | null;
  paidAtMs: number;
  /** "manual" is an operator recording money that arrived outside any
   *  gateway. It carries no session, so `sessionId` is null on that path. */
  source: "webhook" | "reconcile" | "manual";
  /** The real human who recorded this, when there is one. Webhooks have no
   *  actor; a manual payment must never be attributed to "the system". */
  actor?: {
    userId: string;
    name: string;
    role: UserRole;
  } | null;
  /** Free-text method label for a manual payment ("Card terminal", "Bank
   *  transfer"). Never card data. */
  manualMethod?: string | null;
  /** Operator-supplied reference. Validated upstream to reject anything
   *  shaped like a card number. */
  manualReference?: string | null;
}

/**
 * Which attempt an inbound gateway event belongs to.
 *
 *  current    — the session the order is currently pointing at.
 *  superseded — a session this order has explicitly moved on from, because
 *               the operator switched gateway or re-priced. The money is
 *               real, but it is NOT what this order is now asking for.
 *  unknown    — neither. A legacy order with no recorded attempts, or an
 *               event for a session this order never owned.
 *
 * This distinction does not exist anywhere else in the system, and without
 * it a superseded session is indistinguishable from the live one. That was
 * harmless while the gateway pin made a second attempt impossible; it stops
 * being harmless the moment an operator can switch gateway after a decline.
 *
 * Two facts make it load-bearing rather than theoretical:
 *   - `failOrder` never expires the gateway session, and a Stripe decline
 *     happens INSIDE a checkout session that stays open, so a FAILED order
 *     routinely still holds a payable link.
 *   - `applyCheckoutPaid`'s guard is `status: { $ne: PAID }`, which a
 *     superseded session passes cleanly.
 *
 * Pure on purpose: the decision is testable without a database.
 */
export type AttemptClassification = "current" | "superseded" | "unknown";

export function classifyPaymentSession(
  payment: Pick<OrderDoc["payment"], "stripeSessionId" | "attempts">,
  sessionId: string | null | undefined,
): AttemptClassification {
  if (!sessionId) return "unknown";

  // An explicit supersede record BEATS the current pointer, and the order
  // matters. `repriceOrder` and the gateway switch deliberately keep
  // `stripeSessionId` so a late webhook or a dispute stays routable to the
  // attempt that produced it — which means the pointer can still name a
  // session the order has moved on from. Checking the pointer first would
  // then classify a superseded session as current and wave the stale payment
  // straight through to PAID.
  // `.some`, not `.find`. The same session id can legitimately appear more
  // than once in the history — the switch records the incoming attempt, and a
  // later re-price or fallback records it again on the way out — so
  // first-match would happily return the copy that had not yet been stood
  // down and classify a dead session as live. One superseding record is
  // enough: a session that has been superseded never becomes current again.
  const superseded = (payment.attempts ?? []).some(
    (a) => a.sessionId === sessionId && a.supersededAt,
  );
  if (superseded) return "superseded";

  if (payment.stripeSessionId && payment.stripeSessionId === sessionId) {
    return "current";
  }
  return "unknown";
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
/**
 * A gateway reported success on a session that is not the one this order is
 * currently collecting on.
 *
 * Two ways to get here, and the money is real in both:
 *   - the session was SUPERSEDED (the amount changed, or the operator moved
 *     to another gateway) and the customer paid the old link anyway;
 *   - the order is already PAID and a DIFFERENT session also succeeded —
 *     the genuine double-charge, which two live links make possible.
 *
 * Neither can be swallowed and neither can be applied. Applying would settle
 * the order at an amount nobody currently owes; swallowing would lose a real
 * payment. So it is recorded as an attempt, the order is flagged for a human,
 * and an audit row names what happened. This is the operationally visible
 * outcome the invariant demands — the system never silently reaches a wrong
 * PAID state, and it never silently drops money either.
 *
 * Refunding is deliberately not attempted: `PaymentGateway` exposes no refund
 * method, so the resolution is an operator action, not an automated one.
 */
type CompetingKind =
  | "superseded-session"
  | "already-settled"
  | "unknown-session"
  | "amount-mismatch"
  | "state-changed";

/** The gateway a session belongs to. Taken from the recorded attempt when
 *  there is one: after a manual settlement the order's own gateway reads
 *  MANUAL, and a late card payment must not be filed under it. */
function gatewayOfSession(
  order: OrderDocument,
  sessionId: string | null,
): string {
  const attempt = sessionId
    ? (order.payment.attempts ?? []).find((a) => a.sessionId === sessionId)
    : undefined;
  if (attempt?.gateway) return attempt.gateway;
  const current = order.payment.gateway;
  return current && current !== PaymentGatewayKey.MANUAL ? current : "STRIPE";
}

async function recordCompetingPayment(
  order: OrderDocument,
  input: PaidTransitionInput,
  kind: CompetingKind,
  opts: { alreadyClaimed?: boolean } = {},
): Promise<ProcessEventResult> {
  const gatewayKey = gatewayOfSession(order, input.sessionId);

  // No transaction: this path performs one flag-and-record update rather
  // than a multi-document state transition, and the unique index on
  // `gatewayEventId` is the idempotency primitive either way.
  if (!opts.alreadyClaimed) {
    const claimed = await tryClaimGatewayEvent(
      {
        gatewayEventId: input.eventId,
        gateway: gatewayKey,
        orderId: String(order._id),
      },
      null,
    );
    // Same delivery twice is still a no-op: idempotency applies to this path
    // exactly as it does to the success path.
    if (!claimed) {
      return { handled: true, duplicate: true, orderId: String(order._id) };
    }
  }

  const amount =
    typeof input.amountTotal === "number"
      ? input.amountTotal / 100
      : order.pricing.amount;

  const notes: Record<CompetingKind, string> = {
    "superseded-session": `A payment of ${amount} ${order.pricing.currency} succeeded on a superseded checkout session (${input.sessionId}). The order's current amount is ${order.pricing.amount}. Reconcile or refund manually.`,
    "already-settled": `A second payment of ${amount} ${order.pricing.currency} succeeded on session ${input.sessionId} after this order was already settled. Reconcile or refund manually.`,
    "unknown-session": `A payment of ${amount} ${order.pricing.currency} succeeded on session ${input.sessionId}, which is not a session this order issued. The order was left unpaid. Reconcile or refund manually.`,
    "amount-mismatch": `A payment of ${amount} ${order.pricing.currency} succeeded on session ${input.sessionId}, but this order is collecting ${order.pricing.amount}. The order was left unpaid. Reconcile or refund manually.`,
    "state-changed": `A payment of ${amount} ${order.pricing.currency} on session ${input.sessionId} arrived while the order was being changed (re-priced or moved to another gateway). The order was left unpaid. Reconcile or refund manually.`,
  };
  const note = notes[kind];

  await Order.updateOne(
    { _id: order._id },
    {
      $set: {
        "risk.flagged": true,
        "risk.flaggedNote": note,
        "risk.flaggedAt": new Date(),
      },
      $push: {
        "payment.attempts": {
          gateway: gatewayKey,
          sessionId: input.sessionId ?? null,
          paymentIntentId: input.paymentIntentId ?? null,
          checkoutUrl: null,
          amount,
          currency: order.pricing.currency,
          // The attempt genuinely succeeded at the gateway. Recording it as
          // PAID keeps the history truthful; the ORDER is what stays unpaid.
          status: OrderStatus.PAID,
          failureReason: null,
          supersededReason: null,
          supersededAt: new Date(),
          createdAt: new Date(input.paidAtMs),
        },
        "payment.processedWebhookEventIds": {
          $each: [input.eventId],
          $slice: -50,
        },
      },
    },
  );

  await recordAudit({
    action: AuditAction.PAYMENT_COMPETING_SESSION,
    entityType: AuditEntity.ORDER,
    entityId: String(order._id),
    request: null,
    metadata: {
      kind,
      sessionId: input.sessionId,
      paymentIntentId: input.paymentIntentId,
      amount,
      currency: order.pricing.currency,
      currentOrderAmount: order.pricing.amount,
      currentSessionId: order.payment.stripeSessionId ?? null,
      orderStatus: order.status,
      source: input.source,
    },
  });

  logger.error("payments.competing_session", {
    orderId: String(order._id),
    kind,
    sessionId: input.sessionId,
    amount,
    currentOrderAmount: order.pricing.amount,
  });

  return {
    handled: true,
    duplicate: false,
    orderId: String(order._id),
    reason: `competing_payment:${kind}`,
  };
}

export async function applyCheckoutPaid(
  order: OrderDocument,
  input: PaidTransitionInput,
): Promise<ProcessEventResult> {
  const gatewayKey = order.payment.gateway ?? "STRIPE";

  // ─── Stale / competing session gate ────────────────────────────────────
  // Runs BEFORE the transition, and inside this function rather than at each
  // caller, so every path to PAID — Stripe webhook, PayPal webhook, and the
  // reconcile endpoint — inherits it without having to remember to.
  const classification = classifyPaymentSession(order.payment, input.sessionId);
  if (classification === "superseded") {
    return recordCompetingPayment(order, input, "superseded-session");
  }
  // A second, different session succeeding on an order that is already
  // settled is the double-charge case that two live links make possible.
  // `classification === "unknown"` is required here so a legitimate retry of
  // the SAME session stays on the ordinary idempotent path.
  if (
    order.status === OrderStatus.PAID &&
    classification === "unknown" &&
    input.sessionId &&
    order.payment.stripeSessionId &&
    input.sessionId !== order.payment.stripeSessionId
  ) {
    return recordCompetingPayment(order, input, "already-settled");
  }

  const fromGateway = input.source !== "manual";

  // A session this order never issued must not settle it. Before a
  // regenerated link recorded the session it replaced, this was exactly how
  // a payment on the old link settled the order at whatever amount it
  // reported — and the customer's real payment on the new link was then
  // dropped as a duplicate. Orders with no current pointer keep the legacy
  // behaviour.
  if (
    fromGateway &&
    order.status !== OrderStatus.PAID &&
    classification === "unknown" &&
    input.sessionId &&
    order.payment.stripeSessionId &&
    input.sessionId !== order.payment.stripeSessionId
  ) {
    return recordCompetingPayment(order, input, "unknown-session");
  }

  // The money received must be the money this order is collecting. A
  // "success" for a different amount is real money, but settling on it
  // would mark the order fully paid when it is not (or overpaid): it is
  // recorded and flagged for a human instead.
  if (
    fromGateway &&
    order.status !== OrderStatus.PAID &&
    typeof input.amountTotal === "number" &&
    input.amountTotal !==
      toMinorUnits(order.pricing.amount, order.pricing.currency)
  ) {
    return recordCompetingPayment(order, input, "amount-mismatch");
  }

  type TxOutcome =
    | { duplicate: true }
    | { duplicate: false; stateChanged: true }
    | {
        duplicate: false;
        stateChanged?: false;
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
    //
    // The order must also still be the one the gates above approved: the
    // same amount and, for a gateway payment, the same current session. A
    // re-price, regenerate or gateway switch committing between those checks
    // and this write used to let the payment settle an order that had moved
    // on — at the old amount.
    const stillApproved: Record<string, unknown> = {
      "pricing.amount": order.pricing.amount,
    };
    if (fromGateway && input.sessionId && order.payment.stripeSessionId) {
      stillApproved["payment.stripeSessionId"] = input.sessionId;
      stillApproved["payment.attempts"] = {
        $not: {
          $elemMatch: {
            sessionId: input.sessionId,
            supersededAt: { $ne: null },
          },
        },
      };
    }
    const updated = await Order.findOneAndUpdate(
      {
        _id: order._id,
        status: { $ne: OrderStatus.PAID },
        "payment.processedWebhookEventIds": { $ne: input.eventId },
        ...stillApproved,
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
          ...(input.source === "manual"
            ? {
                // MANUAL is stamped only here, on a payment that actually
                // settled offline. It is never written speculatively, so a
                // FAILED order keeps its real merchant-account pin and
                // disputes still route correctly.
                "payment.gateway": PaymentGatewayKey.MANUAL,
                "payment.manualMethod": input.manualMethod ?? null,
                "payment.manualReference": input.manualReference ?? null,
                "payment.checkoutUrl": null,
              }
            : {}),
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
      // Either the order is already PAID (another transition won the race —
      // no audit, no evidence, no outbox enqueue: exactly one confirmation
      // email lifecycle per order), or it changed underneath this payment.
      const now = await Order.findById(order._id, null, sessionOpt(session))
        .select("status payment.processedWebhookEventIds")
        .lean<Pick<OrderDoc, "status"> & {
          payment?: { processedWebhookEventIds?: string[] };
        }>();
      const alreadyApplied =
        !now ||
        now.status === OrderStatus.PAID ||
        (now.payment?.processedWebhookEventIds ?? []).includes(input.eventId);
      return alreadyApplied
        ? { duplicate: true }
        : { duplicate: false, stateChanged: true };
    }

    // 3. Audit + evidence (in-tx; failure aborts everything).
    await recordAudit(
      {
        // Always PAYMENT_SUCCEEDED: money did arrive, whatever route it
        // took. The separate MANUAL_PAYMENT_RECORDED row written by
        // `recordManualPayment` says WHO recorded it and why — two rows
        // with two distinct meanings, rather than one row overloaded.
        action: AuditAction.PAYMENT_SUCCEEDED,
        entityType: AuditEntity.PAYMENT,
        entityId: String(updated._id),
        // A webhook has no human behind it; a manual payment does, and
        // recording it as "nobody" would defeat the point of the audit row.
        actor: input.actor
          ? {
              userId: input.actor.userId,
              name: input.actor.name,
              role: input.actor.role,
            }
          : undefined,
        metadata: {
          orderNumber: updated.orderNumber,
          sessionId: input.sessionId,
          manualMethod: input.manualMethod ?? null,
          manualReference: input.manualReference ?? null,
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

  if (outcome.stateChanged) {
    // The order moved on between the checks and the write. The event is
    // already claimed, so it is recorded here rather than retried.
    if (!fromGateway) {
      // An operator recording money: nothing arrived from a gateway, so there
      // is nothing to file — tell them to look again at the current order.
      throw new ConflictError(
        "The order changed while the payment was being recorded. Reload it and check the amount before recording again.",
      );
    }
    const fresh = await Order.findById(order._id);
    return recordCompetingPayment(fresh ?? order, input, "state-changed", {
      alreadyClaimed: true,
    });
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

/**
 * Is this failure/expiry about a session the order has already moved on
 * from? Such events arrive routinely: replacing a link expires the old
 * session at the gateway, and the gateway then reports that expiry. Applied
 * blindly, they knocked an order whose NEW link was live to EXPIRED/FAILED,
 * and the operator could no longer send it.
 */
function isStaleSessionEvent(
  order: OrderDocument,
  event: VerifiedPaymentEvent,
): boolean {
  if (event.sessionId) {
    const c = classifyPaymentSession(order.payment, event.sessionId);
    if (c === "superseded") return true;
    // "Unknown" only means stale when the order names a DIFFERENT current
    // session. With no pointer at all there is nothing to be stale against,
    // and the event keeps its previous meaning.
    return c === "unknown" && Boolean(order.payment.stripeSessionId);
  }
  // A payment-intent event may carry no session id.
  if (event.paymentIntentId) {
    return (order.payment.attempts ?? []).some(
      (a) => a.paymentIntentId === event.paymentIntentId && a.supersededAt,
    );
  }
  return false;
}

/** Keeps the status write tied to the session the event is about, so a link
 *  replaced between the read and the write is not failed by the old one. */
function currentSessionCondition(
  order: OrderDocument,
  event: VerifiedPaymentEvent,
): Record<string, unknown> {
  return event.sessionId && order.payment.stripeSessionId
    ? { "payment.stripeSessionId": event.sessionId }
    : {};
}

/** Record a stale-session failure/expiry as history, without touching the
 *  order's status. */
async function recordStaleSessionEvent(
  order: OrderDocument,
  event: VerifiedPaymentEvent,
  kind: "expired" | "failed",
  reason?: string,
): Promise<ProcessEventResult> {
  const claimed = await tryClaimGatewayEvent(
    {
      gatewayEventId: event.eventId,
      gateway: gatewayOfSession(order, event.sessionId),
      orderId: String(order._id),
    },
    null,
  );
  if (!claimed) {
    return { handled: true, duplicate: true, orderId: String(order._id) };
  }
  // No `updatedAt` bump: nothing about the order changed, and an operator
  // editing it must not be told it was modified under them.
  await Order.updateOne(
    { _id: order._id },
    {
      $push: {
        "payment.processedWebhookEventIds": {
          $each: [event.eventId],
          $slice: -50,
        },
      },
    },
    { timestamps: false },
  );
  await recordAudit({
    action:
      kind === "expired" ? AuditAction.PAYMENT_EXPIRED : AuditAction.PAYMENT_FAILED,
    entityType: AuditEntity.PAYMENT,
    entityId: String(order._id),
    metadata: {
      eventId: event.eventId,
      sessionId: event.sessionId ?? null,
      paymentIntentId: event.paymentIntentId ?? null,
      reason: reason ?? event.reason ?? null,
      staleSession: true,
      currentSessionId: order.payment.stripeSessionId ?? null,
    },
  });
  logger.info("payments.stale_session_event", {
    orderId: String(order._id),
    kind,
    sessionId: event.sessionId,
    currentSessionId: order.payment.stripeSessionId ?? null,
  });
  return {
    handled: true,
    duplicate: false,
    orderId: String(order._id),
    reason: `stale_session_${kind}`,
  };
}

async function handleCheckoutExpired(
  event: VerifiedPaymentEvent,
  /** Organization whose endpoint received this delivery. Threaded rather
   *  than held in module state: two concurrent deliveries in one process
   *  would clobber a shared variable between the write and the read. */
  organizationId: string | null,
): Promise<ProcessEventResult> {
  const order = await findOrderForEndpoint(organizationId, event);
  if (!order) {
    return { handled: false, duplicate: false, reason: "order_not_found" };
  }
  if (order.status === OrderStatus.PAID) {
    return { handled: true, duplicate: true, orderId: String(order._id) };
  }
  if (isStaleSessionEvent(order, event)) {
    return recordStaleSessionEvent(order, event, "expired");
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
        ...currentSessionCondition(order, event),
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
  /** Organization whose endpoint received this delivery. Threaded rather
   *  than held in module state: two concurrent deliveries in one process
   *  would clobber a shared variable between the write and the read. */
  organizationId: string | null,
): Promise<ProcessEventResult> {
  const order = await findOrderForEndpoint(organizationId, event);
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
  /** Organization whose endpoint received this delivery. Threaded rather
   *  than held in module state: two concurrent deliveries in one process
   *  would clobber a shared variable between the write and the read. */
  organizationId: string | null,
): Promise<ProcessEventResult> {
  const order = await findOrderForEndpoint(organizationId, event);
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
  if (order.status === OrderStatus.PAID) {
    return { handled: true, duplicate: true, orderId: String(order._id) };
  }
  if (isStaleSessionEvent(order, event)) {
    return recordStaleSessionEvent(order, event, "failed", reason);
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
        ...currentSessionCondition(order, event),
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
): Promise<OrderDocument | null> {
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
}

async function handleDisputeCreated(
  event: VerifiedPaymentEvent,
): Promise<ProcessEventResult> {
  const d = event.dispute;
  if (!d) {
    return { handled: false, duplicate: false, reason: "missing_dispute_payload" };
  }
  const order = await findOrderByPaymentIntent(event);
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
    return handleDisputeCreated(event);
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
    await handleDisputeCreated(event);
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
): Promise<ProcessEventResult> {
  const r = event.refund;
  if (!r) {
    return { handled: false, duplicate: false, reason: "missing_refund_payload" };
  }
  const order = await findOrderByPaymentIntent(event);
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
