import "server-only";

import type Stripe from "stripe";

import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { DisputeOutcome, DisputeStatus } from "@/lib/constants/enums";

import { toMinorUnits } from "../currency";
import { getStripe, getStripeForSecret } from "../stripe";
import type {
  CreatePaymentSessionInput,
  CreatedPaymentSession,
  PaymentEventType,
  PaymentGateway,
  SessionStatus,
  VerifiedDisputePayload,
  VerifiedPaymentEvent,
  VerifiedRefundPayload,
} from "../gateway";

/**
 * Stripe implementation of `PaymentGateway`. Talks to the existing
 * `getStripe()` singleton — the rest of the codebase never imports
 * `stripe` directly; they go through this adapter via the registry.
 */

/** Stripe's hosted-checkout expiry must sit between 30 min and 24 h
 *  from "now". We clamp so a misconfigured `paymentExpiryHours` setting
 *  can't produce a session Stripe rejects at create-time. */
function clampStripeExpiry(date: Date): number {
  const now = Date.now();
  const min = now + 31 * 60 * 1000;
  const max = now + 23 * 60 * 60 * 1000 + 30 * 60 * 1000;
  const target = date.getTime();
  const clamped = Math.min(Math.max(target, min), max);
  return Math.floor(clamped / 1000);
}

function mapStripeEventType(type: string): PaymentEventType {
  switch (type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      return "checkout.completed";
    case "checkout.session.expired":
      return "checkout.expired";
    case "checkout.session.async_payment_failed":
      return "checkout.failed";
    case "payment_intent.payment_failed":
      return "payment.failed";
    case "charge.dispute.created":
      return "dispute.created";
    case "charge.dispute.updated":
      return "dispute.updated";
    case "charge.dispute.closed":
      return "dispute.closed";
    case "charge.dispute.funds_withdrawn":
      return "dispute.funds_withdrawn";
    case "charge.refunded":
      return "refund.created";
    default:
      return "unhandled";
  }
}

/**
 * Map Stripe's dispute status string to our DisputeStatus enum. Stripe's
 * canonical values are stable so a 1:1 switch is fine — if Stripe adds
 * a new value we default to UNDER_REVIEW (safe holding state) and log
 * loudly so we notice.
 */
function mapStripeDisputeStatus(raw: string | null | undefined): string {
  switch (raw) {
    case "needs_response":
      return DisputeStatus.NEEDS_RESPONSE;
    case "under_review":
      return DisputeStatus.UNDER_REVIEW;
    case "warning_needs_response":
      return DisputeStatus.WARNING_NEEDS_RESPONSE;
    case "warning_under_review":
      return DisputeStatus.WARNING_UNDER_REVIEW;
    case "warning_closed":
      return DisputeStatus.WARNING_CLOSED;
    case "charge_refunded":
      return DisputeStatus.CHARGE_REFUNDED;
    case "won":
      return DisputeStatus.WON;
    case "lost":
      return DisputeStatus.LOST;
    default:
      logger.warn("stripe.dispute.unknown_status", { raw });
      return DisputeStatus.UNDER_REVIEW;
  }
}

/**
 * Closed-dispute outcome maps directly onto Stripe's terminal statuses.
 * Returns null when the dispute is still open (status is one of the
 * `*_needs_response` / `*_under_review` variants).
 */
function mapStripeDisputeOutcome(
  raw: string | null | undefined,
): string | null {
  switch (raw) {
    case "won":
      return DisputeOutcome.WON;
    case "lost":
      return DisputeOutcome.LOST;
    case "warning_closed":
      return DisputeOutcome.WARNING_CLOSED;
    case "charge_refunded":
      return DisputeOutcome.CHARGE_REFUNDED;
    default:
      return null;
  }
}

/**
 * Builder for a per-credential Stripe gateway.
 *
 * Phase-3 introduces per-org credentials stored in `gateway_credentials`.
 * `getGatewayForOrg` calls this with values pulled from that table.
 *
 * Legacy `stripeGateway` (below) wraps the env-backed credentials so
 * Tenant #1's unchanged flow keeps working — that path is identical to
 * `buildStripeGateway({ secretKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET })`.
 */
export interface StripeGatewayCreds {
  secretKey: string;
  webhookSecret: string;
}

export function buildStripeGateway(
  creds: StripeGatewayCreds,
): PaymentGateway {
  const SECRET = creds.secretKey;
  const WHSEC = creds.webhookSecret;
  const HAS_CREDENTIALS = Boolean(SECRET) && Boolean(WHSEC);
  const IS_SANDBOX =
    SECRET.startsWith("sk_test_") || SECRET.startsWith("rk_test_");
  // Build a Stripe client tied to THESE credentials, not the cached
  // env-backed one. Callers like `verifyWebhook` and `createSession`
  // capture this closure so a per-org gateway never accidentally
  // routes through the wrong account.
  const stripeClient = () =>
    creds.secretKey === env.server.STRIPE_SECRET_KEY
      ? getStripe()
      : getStripeForSecret(creds.secretKey);

  return makeStripeGateway({
    stripe: stripeClient,
    webhookSecret: WHSEC,
    enabled: HAS_CREDENTIALS,
    sandbox: IS_SANDBOX,
  });
}

interface StripeGatewayDeps {
  stripe: () => Stripe;
  webhookSecret: string;
  enabled: boolean;
  sandbox: boolean;
}

function makeStripeGateway(deps: StripeGatewayDeps): PaymentGateway {
  return {
  key: "STRIPE",
  label: "Stripe",
  enabled: deps.enabled,
  sandbox: deps.sandbox,

  async createSession(
    input: CreatePaymentSessionInput,
  ): Promise<CreatedPaymentSession> {
    const stripe = deps.stripe();
    const amountMinor = toMinorUnits(input.amount, input.currency);
    if (amountMinor < 50) {
      throw new Error("Amount is below Stripe's minimum charge");
    }

    const session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        payment_method_types: ["card"],
        customer_email: input.customer.email,
        client_reference_id: input.orderId,
        success_url: `${input.successUrl}?order=${encodeURIComponent(input.orderNumber)}&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${input.cancelUrl}?order=${encodeURIComponent(input.orderNumber)}`,
        expires_at: clampStripeExpiry(input.expiresAt),
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: input.currency.toLowerCase(),
              unit_amount: amountMinor,
              product_data: {
                name: input.productName,
                description: input.description,
                ...(input.imageUrls && input.imageUrls.length > 0
                  ? {
                      images: input.imageUrls.filter((u) =>
                        /^https?:\/\//i.test(u),
                      ),
                    }
                  : {}),
              },
            },
          },
        ],
        metadata: input.metadata,
        payment_intent_data: {
          description: `${input.metadata.appName ?? "PayOps"} • ${input.orderNumber}`,
          metadata: {
            orderId: input.orderId,
            orderNumber: input.orderNumber,
          },
        },
      },
      {
        // Stable idempotency key: re-running this for the same order
        // returns the same Stripe session rather than creating a second
        // orphan. The service-layer guard prevents this in practice;
        // belt-and-suspenders.
        idempotencyKey: `order:${input.orderId}:checkout`,
      },
    );

    if (!session.url) {
      throw new Error("Stripe did not return a checkout URL");
    }

    return {
      sessionId: session.id,
      url: session.url,
      paymentIntentId:
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : null,
      expiresAt: new Date(
        (session.expires_at ?? Math.floor(input.expiresAt.getTime() / 1000)) *
          1000,
      ),
    };
  },

  async expireSession(sessionId: string): Promise<void> {
    const stripe = deps.stripe();
    try {
      await stripe.checkout.sessions.expire(sessionId);
    } catch (err) {
      // Already expired / never existed — best-effort. Caller can still
      // create a fresh session over the top.
      logger.warn("stripe.expire_session_failed", {
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  },

  verifyWebhook(
    rawBody: string | Buffer,
    signatureHeader: string,
  ): VerifiedPaymentEvent {
    const stripe = deps.stripe();
    const event = stripe.webhooks.constructEvent(
      rawBody,
      signatureHeader,
      deps.webhookSecret,
    );

    const session = (() => {
      if (
        event.type === "checkout.session.completed" ||
        event.type === "checkout.session.async_payment_succeeded" ||
        event.type === "checkout.session.async_payment_failed" ||
        event.type === "checkout.session.expired"
      ) {
        return event.data.object as Stripe.Checkout.Session;
      }
      return null;
    })();

    const paymentIntent = (() => {
      if (event.type === "payment_intent.payment_failed") {
        return event.data.object as Stripe.PaymentIntent;
      }
      return null;
    })();

    // Dispute events: extract the Stripe.Dispute. `dispute.payment_intent`
    // carries the PI id back through to our `payment.paymentIntentId`
    // index, which is how the order lookup will work.
    const dispute = (() => {
      if (
        event.type === "charge.dispute.created" ||
        event.type === "charge.dispute.updated" ||
        event.type === "charge.dispute.closed" ||
        event.type === "charge.dispute.funds_withdrawn"
      ) {
        return event.data.object as Stripe.Dispute;
      }
      return null;
    })();

    // Refund events: `charge.refunded` carries the full Charge with its
    // updated refund list. We surface the most-recent refund record.
    const refundCharge = (() => {
      if (event.type === "charge.refunded") {
        return event.data.object as Stripe.Charge;
      }
      return null;
    })();

    const sessionId =
      session?.id ??
      (paymentIntent?.metadata?.sessionId as string | undefined) ??
      null;
    // Stripe surfaces our order id as `client_reference_id` on the
    // session and `metadata.orderId` on the payment-intent. Either is
    // safe to forward — `processGatewayEvent` uses it as a lookup
    // fallback when session-id alone can't find the order. Disputes
    // don't carry our metadata directly; we round-trip via the payment
    // intent id and Order's index on `payment.paymentIntentId`.
    const orderIdFromCharge = (() => {
      const charge = refundCharge;
      if (charge?.metadata?.orderId) return charge.metadata.orderId;
      return null;
    })();
    const orderId =
      (session?.client_reference_id as string | null | undefined) ??
      ((session?.metadata?.orderId as string | undefined) ?? null) ??
      ((paymentIntent?.metadata?.orderId as string | undefined) ?? null) ??
      orderIdFromCharge;
    const paymentIntentId =
      paymentIntent?.id ??
      (session && typeof session.payment_intent === "string"
        ? session.payment_intent
        : null) ??
      (dispute && typeof dispute.payment_intent === "string"
        ? dispute.payment_intent
        : null) ??
      (refundCharge && typeof refundCharge.payment_intent === "string"
        ? refundCharge.payment_intent
        : null) ??
      null;

    const reason =
      paymentIntent?.last_payment_error?.message ??
      (event.type === "checkout.session.async_payment_failed"
        ? "async payment failed"
        : event.type === "checkout.session.expired"
          ? "session expired"
          : null);

    const disputePayload: VerifiedDisputePayload | null = dispute
      ? {
          gatewayDisputeId: dispute.id,
          chargeId:
            typeof dispute.charge === "string" ? dispute.charge : null,
          status: mapStripeDisputeStatus(dispute.status),
          reason: dispute.reason ?? null,
          amountMinor:
            typeof dispute.amount === "number" ? dispute.amount : null,
          currency: dispute.currency ? dispute.currency.toUpperCase() : null,
          evidenceDueByMs:
            typeof dispute.evidence_details?.due_by === "number"
              ? dispute.evidence_details.due_by * 1000
              : null,
          outcome:
            event.type === "charge.dispute.closed"
              ? mapStripeDisputeOutcome(dispute.status)
              : null,
        }
      : null;

    const refundPayload: VerifiedRefundPayload | null = (() => {
      if (!refundCharge) return null;
      // Use the most recent refund record on the charge.
      const refunds = refundCharge.refunds?.data ?? [];
      const latest = refunds[refunds.length - 1] ?? null;
      const chargeId =
        typeof refundCharge.id === "string" ? refundCharge.id : null;
      const totalRefunded =
        typeof refundCharge.amount_refunded === "number"
          ? refundCharge.amount_refunded
          : null;
      return {
        gatewayRefundId: latest?.id ?? `${chargeId ?? "charge"}:refund`,
        chargeId,
        amountMinor:
          typeof latest?.amount === "number" ? latest.amount : totalRefunded,
        amountRefundedTotalMinor: totalRefunded,
        currency: refundCharge.currency
          ? refundCharge.currency.toUpperCase()
          : null,
        reason: latest?.reason ?? null,
      };
    })();

    return {
      eventId: event.id,
      type: mapStripeEventType(event.type),
      sessionId,
      orderId,
      paymentIntentId,
      amountTotalMinor:
        typeof session?.amount_total === "number"
          ? session.amount_total
          : typeof paymentIntent?.amount === "number"
            ? paymentIntent.amount
            : typeof dispute?.amount === "number"
              ? dispute.amount
              : typeof refundCharge?.amount === "number"
                ? refundCharge.amount
                : null,
      occurredAtMs: (event.created ?? Math.floor(Date.now() / 1000)) * 1000,
      reason,
      dispute: disputePayload,
      refund: refundPayload,
      raw: event,
    };
  },

  async getSessionStatus(sessionId: string): Promise<SessionStatus> {
    const stripe = deps.stripe();
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const statusRaw = (session.status ?? "unknown") as string;
    const paymentRaw = (session.payment_status ?? "unknown") as string;
    return {
      status:
        statusRaw === "complete"
          ? "complete"
          : statusRaw === "expired"
            ? "expired"
            : statusRaw === "open"
              ? "open"
              : "unknown",
      paymentStatus:
        paymentRaw === "paid"
          ? "paid"
          : paymentRaw === "unpaid"
            ? "unpaid"
            : paymentRaw === "no_payment_required"
              ? "no_payment_required"
              : "unknown",
      amountTotalMinor:
        typeof session.amount_total === "number" ? session.amount_total : null,
      paymentIntentId:
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : null,
    };
  },
  };
}

/**
 * Legacy env-backed singleton. Tenant #1's existing flow continues to
 * resolve to this via `getDefaultGateway()` / `getGateway("STRIPE")`.
 * New per-org code paths go through `getGatewayForOrg(orgId, "STRIPE")`
 * → `buildStripeGateway(creds)` instead.
 */
export const stripeGateway: PaymentGateway = buildStripeGateway({
  secretKey: env.server.STRIPE_SECRET_KEY,
  webhookSecret: env.server.STRIPE_WEBHOOK_SECRET,
});
