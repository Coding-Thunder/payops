import crypto from "node:crypto";

import type Stripe from "stripe";

/**
 * Stripe event factories.
 *
 * Produces realistic envelopes for the events TraceTxn actually handles:
 *   - checkout.session.completed
 *   - checkout.session.expired
 *   - checkout.session.async_payment_failed
 *   - payment_intent.payment_failed
 *
 * Plus `signWebhook`, a helper that constructs the exact
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
        customer_email: seed.customerEmail ?? "customer@tracetxn.test",
        payment_intent: paymentIntentId,
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
