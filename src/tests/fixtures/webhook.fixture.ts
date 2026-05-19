import type { VerifiedPaymentEvent } from "@/server/payments/gateway";

/**
 * Normalised payment-event fixtures. The webhook processor (and its
 * tests) operate against the gateway-agnostic `VerifiedPaymentEvent`
 * shape — these helpers produce that shape directly, no Stripe SDK
 * needed in tests.
 */

let counter = 0;
function nextEventId(): string {
  counter += 1;
  return `evt_test_${Date.now()}_${counter}`;
}

export interface CompletedFixtureOpts {
  orderId: string;
  orderNumber: string;
  amount?: number;
  currency?: string;
  sessionId?: string;
  eventId?: string;
}

export function completedWebhook(
  opts: CompletedFixtureOpts,
): VerifiedPaymentEvent {
  counter += 1;
  const sessionId =
    opts.sessionId ?? `cs_test_completed_${Date.now()}_${counter}`;
  return {
    eventId: opts.eventId ?? nextEventId(),
    type: "checkout.completed",
    sessionId,
    orderId: opts.orderId,
    paymentIntentId: `pi_test_${counter}`,
    amountTotalMinor: opts.amount ? Math.round(opts.amount * 100) : 19999,
    occurredAtMs: Date.now(),
    reason: null,
    raw: { fixture: true, opts },
  };
}

export function expiredWebhook(opts: {
  orderId: string;
  orderNumber: string;
  sessionId?: string;
  eventId?: string;
}): VerifiedPaymentEvent {
  return {
    eventId: opts.eventId ?? nextEventId(),
    type: "checkout.expired",
    sessionId: opts.sessionId ?? `cs_test_expired_${counter}`,
    orderId: opts.orderId,
    paymentIntentId: null,
    amountTotalMinor: null,
    occurredAtMs: Date.now(),
    reason: "session expired",
    raw: { fixture: true, opts },
  };
}

export function asyncPaymentFailedWebhook(opts: {
  orderId: string;
  orderNumber: string;
  sessionId?: string;
  eventId?: string;
}): VerifiedPaymentEvent {
  return {
    eventId: opts.eventId ?? nextEventId(),
    type: "checkout.failed",
    sessionId: opts.sessionId ?? `cs_test_failed_${counter}`,
    orderId: opts.orderId,
    paymentIntentId: null,
    amountTotalMinor: null,
    occurredAtMs: Date.now(),
    reason: "async payment failed",
    raw: { fixture: true, opts },
  };
}

export function paymentIntentFailedWebhook(opts: {
  paymentIntentId: string;
  message?: string;
}): VerifiedPaymentEvent {
  return {
    eventId: nextEventId(),
    type: "payment.failed",
    sessionId: null,
    orderId: null,
    paymentIntentId: opts.paymentIntentId,
    amountTotalMinor: null,
    occurredAtMs: Date.now(),
    reason: opts.message ?? "payment_intent failed",
    raw: { fixture: true, opts },
  };
}

export interface DisputeFixtureOpts {
  paymentIntentId: string;
  gatewayDisputeId?: string;
  chargeId?: string;
  status?: string;
  reason?: string;
  amount?: number;
  currency?: string;
  evidenceDueByMs?: number | null;
  eventId?: string;
  occurredAtMs?: number;
}

export function disputeCreatedWebhook(
  opts: DisputeFixtureOpts,
): VerifiedPaymentEvent {
  counter += 1;
  return {
    eventId: opts.eventId ?? nextEventId(),
    type: "dispute.created",
    sessionId: null,
    orderId: null,
    paymentIntentId: opts.paymentIntentId,
    amountTotalMinor: opts.amount ? Math.round(opts.amount * 100) : 19999,
    occurredAtMs: opts.occurredAtMs ?? Date.now(),
    reason: opts.reason ?? null,
    dispute: {
      gatewayDisputeId: opts.gatewayDisputeId ?? `du_test_${counter}`,
      chargeId: opts.chargeId ?? `ch_test_${counter}`,
      status: opts.status ?? "NEEDS_RESPONSE",
      reason: opts.reason ?? "fraudulent",
      amountMinor: opts.amount ? Math.round(opts.amount * 100) : 19999,
      currency: opts.currency ?? "USD",
      evidenceDueByMs:
        opts.evidenceDueByMs === undefined
          ? Date.now() + 7 * 24 * 60 * 60 * 1000
          : opts.evidenceDueByMs,
      outcome: null,
    },
    raw: { fixture: true, opts },
  };
}

export function disputeUpdatedWebhook(
  opts: DisputeFixtureOpts & { status: string },
): VerifiedPaymentEvent {
  const base = disputeCreatedWebhook(opts);
  return {
    ...base,
    eventId: opts.eventId ?? nextEventId(),
    type: "dispute.updated",
  };
}

export function disputeClosedWebhook(
  opts: DisputeFixtureOpts & { outcome: "WON" | "LOST" | "WARNING_CLOSED" },
): VerifiedPaymentEvent {
  const base = disputeCreatedWebhook(opts);
  return {
    ...base,
    eventId: opts.eventId ?? nextEventId(),
    type: "dispute.closed",
    dispute: {
      ...base.dispute!,
      status: opts.outcome === "WON" ? "WON" : opts.outcome === "LOST" ? "LOST" : "WARNING_CLOSED",
      outcome: opts.outcome,
    },
  };
}

export interface RefundFixtureOpts {
  paymentIntentId: string;
  gatewayRefundId?: string;
  chargeId?: string;
  /** Amount in major units for this refund event. */
  amount: number;
  /** Cumulative refunded amount across the charge (including this refund). */
  totalRefunded?: number;
  currency?: string;
  reason?: string;
  eventId?: string;
}

export function refundCreatedWebhook(
  opts: RefundFixtureOpts,
): VerifiedPaymentEvent {
  counter += 1;
  const amountMinor = Math.round(opts.amount * 100);
  const totalMinor = Math.round((opts.totalRefunded ?? opts.amount) * 100);
  return {
    eventId: opts.eventId ?? nextEventId(),
    type: "refund.created",
    sessionId: null,
    orderId: null,
    paymentIntentId: opts.paymentIntentId,
    amountTotalMinor: amountMinor,
    occurredAtMs: Date.now(),
    reason: opts.reason ?? null,
    refund: {
      gatewayRefundId: opts.gatewayRefundId ?? `re_test_${counter}`,
      chargeId: opts.chargeId ?? `ch_test_${counter}`,
      amountMinor,
      amountRefundedTotalMinor: totalMinor,
      currency: opts.currency ?? "USD",
      reason: opts.reason ?? null,
    },
    raw: { fixture: true, opts },
  };
}
