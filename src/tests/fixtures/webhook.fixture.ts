import type Stripe from "stripe";

import {
  buildAsyncPaymentFailed,
  buildCheckoutCompleted,
  buildCheckoutExpired,
  buildPaymentIntentFailed,
} from "@/tests/factories/stripe-event.factory";

/**
 * Pre-cooked Stripe webhook envelopes for the common scenarios webhook
 * tests reach for. Each function returns a fresh event object — mutating
 * the result is safe.
 */

export interface CompletedFixtureOpts {
  orderId: string;
  orderNumber: string;
  amount?: number;
  currency?: string;
  sessionId?: string;
  eventId?: string;
}

export function completedWebhook(opts: CompletedFixtureOpts): Stripe.Event {
  return buildCheckoutCompleted({
    id: opts.eventId,
    sessionId: opts.sessionId,
    orderId: opts.orderId,
    orderNumber: opts.orderNumber,
    amountTotal: opts.amount ? Math.round(opts.amount * 100) : 19999,
    currency: opts.currency ?? "usd",
  });
}

export function expiredWebhook(opts: {
  orderId: string;
  orderNumber: string;
  sessionId?: string;
  eventId?: string;
}): Stripe.Event {
  return buildCheckoutExpired({
    id: opts.eventId,
    sessionId: opts.sessionId,
    orderId: opts.orderId,
    orderNumber: opts.orderNumber,
  });
}

export function asyncPaymentFailedWebhook(opts: {
  orderId: string;
  orderNumber: string;
  sessionId?: string;
  eventId?: string;
}): Stripe.Event {
  return buildAsyncPaymentFailed({
    id: opts.eventId,
    sessionId: opts.sessionId,
    orderId: opts.orderId,
    orderNumber: opts.orderNumber,
  });
}

export function paymentIntentFailedWebhook(opts: {
  paymentIntentId: string;
  message?: string;
}): Stripe.Event {
  return buildPaymentIntentFailed(opts);
}
