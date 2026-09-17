import type { OrderDTO } from "@/types";

/**
 * Failure reasons PayOps writes itself when an operator stands a link down
 * (re-price, regenerate, gateway switch) — as opposed to a decline or expiry
 * the gateway reported. Keep in step with `supersedeCurrentAttempt`.
 */
const OPERATOR_SUPERSEDE_REASONS: ReadonlySet<string> = new Set([
  "Superseded by an amount change",
  "Replaced by a regenerated link",
  "Superseded by a gateway change",
  "Replaced by a manual payment request",
  // Stood down by PayPal-side safety, not declined: see
  // HELD_PAYMENT_STAND_DOWN_REASON in the webhook service.
  "A payment was already received on an earlier link, so this link was stopped to avoid charging the customer twice. Reconcile it before collecting again.",
]);

export function isOperatorSupersede(reason: string | null | undefined): boolean {
  return Boolean(reason) && OPERATOR_SUPERSEDE_REASONS.has(reason as string);
}

/**
 * True when the order's recorded session was stood down. The session id is
 * kept on the order after that (late webhooks and disputes must still route),
 * so its presence alone does not make it the session being collected on.
 */
export function isSessionSuperseded(payment: OrderDTO["payment"]): boolean {
  const id = payment.paymentSessionId;
  if (!id) return false;
  return (payment.attempts ?? []).some((a) => a.sessionId === id && a.supersededAt);
}

interface HeldCheckInput {
  risk?: { flagged?: boolean | null } | null;
  payment: {
    attempts?: ReadonlyArray<{
      status: string;
      held?: boolean | null;
      heldReviewedAt?: unknown;
      heldKind?: string | null;
      supersededAt?: unknown;
      amount?: number;
      gateway?: string;
      sessionId?: string | null;
    }> | null;
  };
}

/**
 * Money a gateway took that the order did not accept — a payment on a
 * stood-down link, or at the wrong amount — and that no one has reconciled
 * yet. While any is outstanding, collecting again risks charging the
 * customer twice. Reconciled means the operator cleared the order's flag.
 *
 * Older records predate the `held` marker: a PAID attempt that was also
 * superseded can only have come from the same path.
 */
export function outstandingHeldPayments<T extends HeldCheckInput>(
  order: T,
): NonNullable<T["payment"]["attempts"]>[number][] {
  if (!order.risk?.flagged) return [];
  return (order.payment.attempts ?? []).filter(
    (a) =>
      a.status === "PAID" &&
      (a.held || Boolean(a.supersededAt)) &&
      !a.heldReviewedAt,
  );
}

/** Where a held payment came from, as the operator should read it. */
export function heldPaymentSource(a: {
  heldKind?: string | null;
  supersededAt?: unknown;
}): string {
  switch (a.heldKind) {
    case "superseded-session":
      return "on an earlier link";
    case "unknown-session":
      return "on a link this order did not issue";
    case "amount-mismatch":
      return "for the wrong amount";
    case "already-settled":
      return "after the order was already paid";
    case "state-changed":
      return "while the order was being changed";
    default:
      return a.supersededAt ? "on an earlier link" : "for the wrong amount";
  }
}
