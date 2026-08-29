import crypto from "node:crypto";

import type Stripe from "stripe";

/**
 * Stripe event factories.
 *
 * Produces realistic envelopes for the events PayOps actually handles:
 *   - checkout.session.completed
 *   - checkout.session.expired
 *   - checkout.session.async_payment_failed
 *   - payment_intent.payment_failed
 *   - payment_intent.amount_capturable_updated
 *   - payment_intent.succeeded
 *   - payment_intent.canceled
 *
 * Plus `signWebhook` — a helper that constructs the exact
 * `t=<unix>,v1=<sig>` header Stripe sends, so tests can verify our
 * signature-handling code end-to-end.
 *
 * Webhook IDs are deterministic per call (`evt_test_<uuid>`) so dedupe
 * tests can assert on stable values.
 */

let eventCounter = 0;

function eventId(prefix = "evt_test"): string {
  eventCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${eventCounter.toString(36)}`;
}

interface CheckoutCompletedSeed {
  id?: string;
  sessionId?: string;
  paymentIntentId?: string;
  orderId: string;
  orderNumber: string;
  amountTotal?: number;
  currency?: string;
  customerEmail?: string;
  /**
   * Stripe's own `payment_status`, DEFAULTED TO "paid".
   *
   * The default is load-bearing: every existing caller of this builder
   * describes a completed automatic-capture checkout, and the webhook
   * adapter routes on `payment_status === "unpaid"`. Defaulting to "paid"
   * keeps all of them on the exact path they take today. Manual-capture
   * tests pass "unpaid" explicitly — that is the authorization case.
   */
  paymentStatus?: "paid" | "unpaid" | "no_payment_required";
}

export function buildCheckoutCompleted(
  seed: CheckoutCompletedSeed,
): Stripe.Event {
  const sessionId = seed.sessionId ?? `cs_test_completed_${Date.now()}`;
  const paymentIntentId = seed.paymentIntentId ?? `pi_test_${Date.now()}`;
  return {
    id: seed.id ?? eventId(),
    object: "event",
    api_version: "2024-06-20",
    created: Math.floor(Date.now() / 1000),
    type: "checkout.session.completed",
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    data: {
      object: {
        id: sessionId,
        object: "checkout.session",
        mode: "payment",
        status: "complete",
        client_reference_id: seed.orderId,
        customer_email: seed.customerEmail ?? "customer@payops.test",
        payment_intent: paymentIntentId,
        payment_status: seed.paymentStatus ?? "paid",
        amount_total: seed.amountTotal ?? 19950,
        currency: seed.currency ?? "usd",
        metadata: {
          orderId: seed.orderId,
          orderNumber: seed.orderNumber,
        },
      } as unknown as Stripe.Checkout.Session,
    },
  } as Stripe.Event;
}

export function buildCheckoutExpired(seed: {
  id?: string;
  sessionId?: string;
  orderId: string;
  orderNumber: string;
}): Stripe.Event {
  const sessionId = seed.sessionId ?? `cs_test_expired_${Date.now()}`;
  return {
    id: seed.id ?? eventId(),
    object: "event",
    api_version: "2024-06-20",
    created: Math.floor(Date.now() / 1000),
    type: "checkout.session.expired",
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    data: {
      object: {
        id: sessionId,
        object: "checkout.session",
        mode: "payment",
        status: "expired",
        client_reference_id: seed.orderId,
        metadata: { orderId: seed.orderId, orderNumber: seed.orderNumber },
      } as unknown as Stripe.Checkout.Session,
    },
  } as Stripe.Event;
}

export function buildAsyncPaymentFailed(seed: {
  id?: string;
  sessionId?: string;
  orderId: string;
  orderNumber: string;
}): Stripe.Event {
  const sessionId = seed.sessionId ?? `cs_test_async_failed_${Date.now()}`;
  return {
    id: seed.id ?? eventId(),
    object: "event",
    api_version: "2024-06-20",
    created: Math.floor(Date.now() / 1000),
    type: "checkout.session.async_payment_failed",
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    data: {
      object: {
        id: sessionId,
        object: "checkout.session",
        mode: "payment",
        status: "open",
        client_reference_id: seed.orderId,
        metadata: { orderId: seed.orderId, orderNumber: seed.orderNumber },
      } as unknown as Stripe.Checkout.Session,
    },
  } as Stripe.Event;
}

export function buildPaymentIntentFailed(seed: {
  id?: string;
  paymentIntentId: string;
  message?: string;
}): Stripe.Event {
  return {
    id: seed.id ?? eventId(),
    object: "event",
    api_version: "2024-06-20",
    created: Math.floor(Date.now() / 1000),
    type: "payment_intent.payment_failed",
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    data: {
      object: {
        id: seed.paymentIntentId,
        object: "payment_intent",
        status: "requires_payment_method",
        last_payment_error: {
          message: seed.message ?? "Your card was declined.",
        },
      } as unknown as Stripe.PaymentIntent,
    },
  } as Stripe.Event;
}

/* ------------------------------------------------------------------ *
 * Manual-capture PaymentIntent events.
 *
 * All three carry a real `capture_method`, because the adapter maps
 * `payment_intent.succeeded` / `.canceled` to a handled type ONLY when it
 * reads "manual" — an automatic-capture intent must stay "unhandled" or the
 * moment an order is marked paid would move for the incumbent brands.
 * `capture_method` therefore defaults to "manual" here: these builders exist
 * to describe the manual flow, and an automatic-capture test passes
 * "automatic" explicitly to assert that it is ignored.
 *
 * `metadata.orderId` is what lets the webhook pipeline find the order from a
 * bare payment-intent event, which carries no `client_reference_id`.
 * ------------------------------------------------------------------ */

interface PaymentIntentSeed {
  id?: string;
  paymentIntentId?: string;
  orderId?: string;
  orderNumber?: string;
  sessionId?: string;
  captureMethod?: "manual" | "automatic" | "automatic_async";
  status?: string;
  amountCapturable?: number;
  amountReceived?: number;
  currency?: string;
  cancellationReason?:
    | "abandoned"
    | "automatic"
    | "duplicate"
    | "failed_invoice"
    | "fraudulent"
    | "requested_by_customer"
    | "void_invoice"
    | null;
}

function paymentIntentEvent(
  type: string,
  seed: PaymentIntentSeed,
  defaults: {
    status: string;
    amountCapturable: number;
    amountReceived: number;
    cancellationReason: PaymentIntentSeed["cancellationReason"];
  },
): Stripe.Event {
  const amountCapturable = seed.amountCapturable ?? defaults.amountCapturable;
  const amountReceived = seed.amountReceived ?? defaults.amountReceived;
  return {
    id: seed.id ?? eventId(),
    object: "event",
    api_version: "2024-06-20",
    created: Math.floor(Date.now() / 1000),
    type,
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    data: {
      object: {
        id: seed.paymentIntentId ?? `pi_test_${Date.now()}`,
        object: "payment_intent",
        capture_method: seed.captureMethod ?? "manual",
        status: seed.status ?? defaults.status,
        amount: Math.max(amountCapturable, amountReceived),
        amount_capturable: amountCapturable,
        amount_received: amountReceived,
        currency: seed.currency ?? "usd",
        cancellation_reason:
          seed.cancellationReason === undefined
            ? defaults.cancellationReason
            : seed.cancellationReason,
        metadata: {
          ...(seed.orderId ? { orderId: seed.orderId } : {}),
          ...(seed.orderNumber ? { orderNumber: seed.orderNumber } : {}),
          ...(seed.sessionId ? { sessionId: seed.sessionId } : {}),
        },
      } as unknown as Stripe.PaymentIntent,
    },
  } as Stripe.Event;
}

/**
 * `payment_intent.amount_capturable_updated` — the customer authorized and
 * the funds are held. Stripe fires this ONLY under manual capture.
 */
export function buildAmountCapturableUpdated(
  seed: PaymentIntentSeed = {},
): Stripe.Event {
  return paymentIntentEvent("payment_intent.amount_capturable_updated", seed, {
    status: "requires_capture",
    amountCapturable: 19950,
    amountReceived: 0,
    cancellationReason: null,
  });
}

/** `payment_intent.succeeded` — the held funds were actually captured. */
export function buildPaymentIntentSucceeded(
  seed: PaymentIntentSeed = {},
): Stripe.Event {
  return paymentIntentEvent("payment_intent.succeeded", seed, {
    status: "succeeded",
    amountCapturable: 0,
    amountReceived: 19950,
    cancellationReason: null,
  });
}

/**
 * `payment_intent.canceled` — the hold was released without a charge.
 * The default reason is the operator-initiated release; pass "automatic"
 * or "abandoned" for the authorization Stripe aged out on its own.
 */
export function buildPaymentIntentCanceled(
  seed: PaymentIntentSeed = {},
): Stripe.Event {
  return paymentIntentEvent("payment_intent.canceled", seed, {
    status: "canceled",
    amountCapturable: 0,
    amountReceived: 0,
    cancellationReason: "requested_by_customer",
  });
}

/**
 * Signs a serialized JSON payload with the supplied webhook secret using
 * the same scheme Stripe uses: `t=<unix>,v1=<hmac-sha256>`. Tests post
 * the payload + this header to /api/webhooks/stripe and the real
 * signature verifier accepts it.
 */
export function signWebhook(
  payload: string,
  secret: string,
  timestamp?: number,
): string {
  const t = timestamp ?? Math.floor(Date.now() / 1000);
  const sig = crypto
    .createHmac("sha256", secret)
    .update(`${t}.${payload}`)
    .digest("hex");
  return `t=${t},v1=${sig}`;
}
