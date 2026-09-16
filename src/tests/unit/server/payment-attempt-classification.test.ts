import { describe, expect, it } from "vitest";

import { OrderStatus, PaymentGatewayKey } from "@/lib/constants/enums";
import { classifyPaymentSession } from "@/server/services/webhook.service";

/**
 * A superseded checkout session must be distinguishable from the live one.
 *
 * This is the primitive the Stripe→PayPal switch rests on. Two verified
 * facts make it necessary rather than defensive:
 *
 *   1. `failOrder` sets three status fields and never expires the gateway
 *      session, and Stripe's `payment_intent.payment_failed` fires on a
 *      declined card INSIDE a checkout session that stays open. So a FAILED
 *      order routinely still holds a payable link in the customer's inbox.
 *   2. `applyCheckoutPaid`'s serialization guard is `status: { $ne: PAID }`,
 *      which a payment on a superseded session passes cleanly.
 *
 * Together those mean that, without this classifier, a customer paying the
 * old Stripe link after the operator switched to PayPal would be applied to
 * the order as if it were the current attempt — at the current amount.
 */

const attempt = (over: Partial<{
  gateway: PaymentGatewayKey;
  sessionId: string | null;
  supersededAt: Date | null;
  supersededReason: "GATEWAY_SWITCHED" | "REPRICED" | null;
}> = {}) => ({
  gateway: PaymentGatewayKey.STRIPE,
  sessionId: "cs_old",
  paymentIntentId: null,
  checkoutUrl: null,
  amount: 249.99,
  currency: "USD",
  status: OrderStatus.FAILED,
  failureReason: null,
  supersededReason: "GATEWAY_SWITCHED" as const,
  supersededAt: new Date("2026-09-16T10:00:00Z"),
  createdAt: new Date("2026-09-16T09:00:00Z"),
  ...over,
});

describe("classifyPaymentSession", () => {
  it("recognises the session the order currently points at", () => {
    expect(
      classifyPaymentSession(
        { stripeSessionId: "cs_live", attempts: [] },
        "cs_live",
      ),
    ).toBe("current");
  });

  it("recognises a session the order has moved on from", () => {
    // The Stripe→PayPal case: order now points at a PayPal order id, and the
    // old Stripe session is recorded as superseded.
    expect(
      classifyPaymentSession(
        { stripeSessionId: "PAYPAL-ORDER-1", attempts: [attempt()] },
        "cs_old",
      ),
    ).toBe("superseded");
  });

  it("does NOT treat a still-current attempt in history as superseded", () => {
    // An attempt is recorded the moment it is created, before it is
    // superseded. Its presence in the array is not what makes it dead —
    // `supersededAt` is.
    expect(
      classifyPaymentSession(
        { stripeSessionId: "cs_live", attempts: [attempt({ sessionId: "cs_live", supersededAt: null, supersededReason: null })] },
        "cs_live",
      ),
    ).toBe("current");
  });

  it("reports unknown for a session this order never owned", () => {
    expect(
      classifyPaymentSession(
        { stripeSessionId: "cs_live", attempts: [attempt()] },
        "cs_someone_elses",
      ),
    ).toBe("unknown");
  });

  it("reports unknown for a legacy order with no recorded attempts", () => {
    // `.lean()` bypasses Mongoose defaults, so every order written before
    // the attempts array exists reads back without the field. That must be
    // safe, not a crash.
    expect(
      classifyPaymentSession({ stripeSessionId: "cs_live" }, "cs_other"),
    ).toBe("unknown");
    expect(
      classifyPaymentSession({ stripeSessionId: "cs_live" }, "cs_live"),
    ).toBe("current");
  });

  it("reports unknown for a missing session id rather than guessing", () => {
    expect(
      classifyPaymentSession({ stripeSessionId: "cs_live", attempts: [] }, null),
    ).toBe("unknown");
    expect(
      classifyPaymentSession({ stripeSessionId: "cs_live", attempts: [] }, undefined),
    ).toBe("unknown");
  });

  it("does not mistake a superseded REPRICE for the live session", () => {
    // Same gateway, new session after an amount change. The old link is
    // still payable at the OLD amount — exactly what must not be applied.
    expect(
      classifyPaymentSession(
        {
          stripeSessionId: "cs_new",
          attempts: [attempt({ sessionId: "cs_old", supersededReason: "REPRICED" })],
        },
        "cs_old",
      ),
    ).toBe("superseded");
  });
});

describe("classifyPaymentSession — supersede beats the stale pointer", () => {
  it("classifies a superseded session even while the order still points at it", () => {
    // `repriceOrder` and the gateway switch KEEP `stripeSessionId` so a late
    // webhook or a dispute stays routable to the attempt that produced it.
    // That means the pointer can name a session the order has moved on from,
    // and checking the pointer first would wave a stale payment through to
    // PAID at an amount nobody owes. Caught by the service-layer test, not
    // by inspection.
    expect(
      classifyPaymentSession(
        {
          stripeSessionId: "cs_A",
          attempts: [attempt({ sessionId: "cs_A", supersededReason: "REPRICED" })],
        },
        "cs_A",
      ),
    ).toBe("superseded");
  });
});
