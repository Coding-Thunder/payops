import "server-only";

import type Stripe from "stripe";

import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { DisputeOutcome, DisputeStatus } from "@/lib/constants/enums";

import { toMinorUnits } from "../currency";
import { getStripeFor } from "../stripe";
import type {
  CancelResult,
  CaptureResult,
  CreatePaymentSessionInput,
  CreatedPaymentSession,
  PaymentEventType,
  PaymentGateway,
  SessionStatus,
  VerifiedAuthorizationPayload,
  VerifiedDisputePayload,
  VerifiedPaymentEvent,
  VerifiedRefundPayload,
  WebhookHeaders,
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

/**
 * Stripe event type → our normalised event type.
 *
 * The three manual-capture additions are gated on POSITIVE evidence that
 * the intent is manual-capture, taken from the payload itself rather than
 * from any notion of which organization we think this is:
 *
 *   - `amount_capturable_updated` fires ONLY under manual capture, so it
 *     needs no gate.
 *   - `payment_intent.succeeded` and `payment_intent.canceled` fire for
 *     AUTOMATIC capture too. Both were previously "unhandled", and they
 *     must STAY unhandled for automatic-capture orders or the moment an
 *     order is marked paid would shift for RentalConfirmation — from
 *     `checkout.session.completed` to whichever of the two Stripe happened
 *     to deliver first. `capture_method` is a non-optional field on
 *     PaymentIntent, so `=== "manual"` is exact.
 */
function mapStripeEventType(
  type: string,
  paymentIntent: Stripe.PaymentIntent | null,
): PaymentEventType {
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
    case "payment_intent.amount_capturable_updated":
      return "payment.authorized";
    case "payment_intent.succeeded":
      return paymentIntent?.capture_method === "manual"
        ? "payment.captured"
        : "unhandled";
    case "payment_intent.canceled":
      return paymentIntent?.capture_method === "manual"
        ? "payment.cancelled"
        : "unhandled";
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

/** The two secrets a Stripe account needs. Held per organization in the
 *  credential vault; falls back to the deployment env. */
export interface StripeCredentials {
  secretKey: string;
  webhookSecret: string;
}

/**
 * Build a Stripe gateway over a credential source.
 *
 * The resolver is a FUNCTION, not a value, for two reasons. It defers the
 * env read out of module scope — previously `const SECRET =
 * env.server.STRIPE_SECRET_KEY` executed on import, which froze the whole
 * memoised env snapshot the moment anything touched the gateway registry
 * (the cause of the per-file test-database bug fixed in 55b5e47). And it
 * lets one organization's gateway be constructed from vault credentials
 * while the default instance keeps reading env, with no second code path.
 */
export function createStripeGateway(
  credentials: () => StripeCredentials,
): PaymentGateway {
  return {
  key: "STRIPE",
  label: "Stripe",
  get enabled() {
    return Boolean(credentials().secretKey);
  },
  get sandbox() {
    const key = credentials().secretKey;
    return key.startsWith("sk_test_") || key.startsWith("rk_test_");
  },

  async createSession(
    input: CreatePaymentSessionInput,
  ): Promise<CreatedPaymentSession> {
    const stripe = getStripeFor(credentials().secretKey);
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
          // Emitted ONLY on a positive manual request. When
          // `captureMethod` is undefined — which is every call made on
          // behalf of RentalConfirmation and TripReservations — this
          // spreads to nothing and the outgoing payload is byte-identical
          // to what it was before manual capture existed.
          ...(input.captureMethod === "manual"
            ? { capture_method: "manual" as const }
            : {}),
        },
      },
      {
        // Stable idempotency key: re-running this for the same order
        // returns the same Stripe session rather than creating a second
        // orphan. The service-layer guard prevents this in practice;
        // belt-and-suspenders.
        //
        // Namespaced for manual capture because re-authorizing after a
        // released hold is a NORMAL operation there, and Stripe honours an
        // idempotency key for 24h — without the suffix the operator would
        // silently be handed back the dead session. The automatic key is
        // left exactly as it was; `stripe-session.characterization.test.ts`
        // pins it.
        idempotencyKey:
          input.captureMethod === "manual"
            ? `order:${input.orderId}:checkout:manual`
            : `order:${input.orderId}:checkout`,
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
    const stripe = getStripeFor(credentials().secretKey);
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
    headers: WebhookHeaders,
  ): VerifiedPaymentEvent {
    // Stripe's scheme is a local HMAC over one header — no network, so this
    // stays synchronous even though the interface permits a promise.
    const signatureHeader = headers.get("stripe-signature") ?? "";
    const { secretKey, webhookSecret } = credentials();
    const stripe = getStripeFor(secretKey);
    // Verified against THIS organization's signing secret. A signature made
    // with another organization's secret must fail here, which is what stops
    // one tenant's webhook from being accepted as another's.
    const event = stripe.webhooks.constructEvent(
      rawBody,
      signatureHeader,
      webhookSecret,
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
      if (
        event.type === "payment_intent.payment_failed" ||
        event.type === "payment_intent.amount_capturable_updated" ||
        event.type === "payment_intent.succeeded" ||
        event.type === "payment_intent.canceled"
      ) {
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

    /**
     * THE MANUAL-CAPTURE GUARD.
     *
     * Under `capture_method: manual`, Stripe fires
     * `checkout.session.completed` the moment the customer authorizes —
     * with `payment_status: "unpaid"` and the PaymentIntent sitting in
     * `requires_capture`. Left alone, that event would run straight into
     * `applyCheckoutPaid` and mark the order PAID, stamp `paidAt`, publish
     * ORDER_PAID and email a receipt, all for money that has not moved.
     *
     * The test is deliberately the POSITIVE `=== "unpaid"`, never
     * `!== "paid"`. `payment_status` is a non-optional field on the real
     * Stripe Checkout.Session, so the positive test is exact in
     * production — while the existing test factory omits the key
     * entirely, so a negative test would silently reroute every existing
     * webhook test and change behaviour for both incumbent brands.
     *
     * Keyed off the SESSION, not off which organization we think this is:
     * an automatic-capture session reports "paid" and takes the identical
     * branch it has always taken.
     */
    let type = mapStripeEventType(event.type, paymentIntent);
    if (type === "checkout.completed" && session?.payment_status === "unpaid") {
      type = "payment.authorized";
    }

    const authorizationPayload: VerifiedAuthorizationPayload | null =
      type === "payment.authorized" ||
      type === "payment.captured" ||
      type === "payment.cancelled"
        ? {
            paymentIntentId:
              paymentIntent?.id ??
              (session && typeof session.payment_intent === "string"
                ? session.payment_intent
                : null),
            captureMethod: paymentIntent?.capture_method ?? null,
            paymentIntentStatus: paymentIntent?.status ?? null,
            amountCapturableMinor:
              typeof paymentIntent?.amount_capturable === "number"
                ? paymentIntent.amount_capturable
                : null,
            amountReceivedMinor:
              typeof paymentIntent?.amount_received === "number"
                ? paymentIntent.amount_received
                : null,
            cancellationReason: paymentIntent?.cancellation_reason ?? null,
          }
        : null;

    return {
      eventId: event.id,
      type,
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
      authorization: authorizationPayload,
      raw: event,
    };
  },

  async getSessionStatus(sessionId: string): Promise<SessionStatus> {
    const stripe = getStripeFor(credentials().secretKey);
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
      // Derived only from what `checkout.sessions.retrieve` ALREADY
      // returns. Deliberately no `expand: ["payment_intent"]` — that would
      // change the outgoing request for the two incumbent brands' reconcile
      // calls. The ORDER's own pinned `payment.capture.method` is the
      // authority on capture mode; this is a hint, not the source of truth.
      captureMethod: null,
      amountCapturableMinor: null,
      paymentIntentStatus: null,
    };
  },

  /**
   * Stripe genuinely supports authorize-then-capture, so it advertises the
   * optional capability. PayPal and the unimplemented registry placeholders
   * do not, and `supportsManualCapture()` narrows them out at the call site.
   */
  supportsManualCapture: true,

  /**
   * Convert an authorized hold into an actual charge.
   *
   * Callers pass an idempotency key derived from the order so an operator
   * double-clicking "Capture payment" cannot charge the customer twice —
   * Stripe replays the first result rather than issuing a second capture.
   */
  async capturePayment(
    paymentIntentId: string,
    opts?: { amountMinor?: number | null; idempotencyKey?: string },
  ): Promise<CaptureResult> {
    const stripe = getStripeFor(credentials().secretKey);
    const params: Stripe.PaymentIntentCaptureParams =
      typeof opts?.amountMinor === "number"
        ? { amount_to_capture: opts.amountMinor, final_capture: true }
        : {};
    const intent = await stripe.paymentIntents.capture(
      paymentIntentId,
      params,
      opts?.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : undefined,
    );
    return {
      paymentIntentId: intent.id,
      status: intent.status,
      amountReceivedMinor:
        typeof intent.amount_received === "number"
          ? intent.amount_received
          : null,
    };
  },

  /**
   * Release an authorization without charging. This is what happens when
   * the operator cannot fulfil the booking — the customer's held funds go
   * back rather than being taken and refunded, which is both faster for
   * them and cheaper for the merchant.
   */
  async cancelPayment(
    paymentIntentId: string,
    opts?: {
      reason?: "abandoned" | "duplicate" | "fraudulent" | "requested_by_customer";
      idempotencyKey?: string;
    },
  ): Promise<CancelResult> {
    const stripe = getStripeFor(credentials().secretKey);
    const params: Stripe.PaymentIntentCancelParams = opts?.reason
      ? { cancellation_reason: opts.reason }
      : {};
    const intent = await stripe.paymentIntents.cancel(
      paymentIntentId,
      params,
      opts?.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : undefined,
    );
    return { paymentIntentId: intent.id, status: intent.status };
  },
  };
}

/**
 * The deployment-level Stripe gateway, reading `STRIPE_SECRET_KEY` and
 * `STRIPE_WEBHOOK_SECRET` at call time.
 *
 * This is what the registry exposes, what every existing caller already
 * uses, and what an organization with no stored credentials falls back to.
 * Keeping it as a plain instance of the same factory means there is exactly
 * one Stripe implementation — the per-organization path is not a fork.
 */
export const stripeGateway: PaymentGateway = createStripeGateway(() => ({
  secretKey: env.server.STRIPE_SECRET_KEY,
  webhookSecret: env.server.STRIPE_WEBHOOK_SECRET,
}));
