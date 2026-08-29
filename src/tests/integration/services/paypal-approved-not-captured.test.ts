import { beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";

import { OrderStatus, PaymentGatewayKey, UserRole } from "@/lib/constants/enums";
import { paymentAmountLabel } from "@/lib/format";
import { Order } from "@/server/db/models";
import { getOrderByNumber } from "@/server/services/order.service";
import { applyCheckoutPaid } from "@/server/services/webhook.service";
import { actorFor } from "@/tests/utils/auth";
import { ensureMongo } from "@/tests/utils/db";
import { createOrder } from "@/tests/factories/order.factory";

/**
 * An approved-but-uncaptured PayPal payment must not read as paid.
 *
 * PayPal splits approval from capture: the customer is redirected back to
 * the return page the moment they approve, and no money has moved until a
 * capture succeeds. A live order sat in exactly that state — PayPal order
 * APPROVED, zero captures — while the page announced "AMOUNT PAID $0.50".
 *
 * These tests pin the two halves of that. The data half: an order in this
 * state carries no `amountReceived` and no `paidAt`, so nothing downstream
 * can mistake it for settled. The display half: the label rule only claims
 * payment once the order is actually PAID.
 *
 * Nothing here contacts PayPal or moves money.
 */

const actor = actorFor(UserRole.ADMIN);

/** The state the live order was found in: link generated, customer
 *  approved at PayPal, no capture, no webhook ever claimed. */
async function approvedButNotCaptured() {
  return createOrder({
    status: OrderStatus.PAYMENT_PENDING,
    payment: {
      gateway: PaymentGatewayKey.PAYPAL,
      stripeSessionId: "85N33701GC591621L",
      status: OrderStatus.PAYMENT_PENDING,
    },
  });
}

beforeEach(async () => {
  await ensureMongo();
});

describe("an approved PayPal order that was never captured", () => {
  it("records no amount received and no paid timestamp", async () => {
    const doc = await approvedButNotCaptured();
    const order = await getOrderByNumber(doc.orderNumber);

    expect(order?.status).toBe(OrderStatus.PAYMENT_PENDING);
    expect(order?.payment.amountReceived ?? null).toBeNull();
    expect(order?.payment.paidAt ?? null).toBeNull();
  });

  it("has claimed no gateway event", async () => {
    const doc = await approvedButNotCaptured();
    const fresh = await Order.findById(doc._id).lean<{
      payment: { processedWebhookEventIds: string[] };
    }>();

    // Approval produces no capture event, so there is nothing to claim.
    expect(fresh?.payment.processedWebhookEventIds).toEqual([]);
  });

  it("is not labelled as paid on the return page", async () => {
    const doc = await approvedButNotCaptured();
    const order = await getOrderByNumber(doc.orderNumber);

    // The page's `stillPending` is exactly this: pending, with a session
    // the gateway has already been handed.
    const stillPending =
      order?.status === OrderStatus.PAYMENT_PENDING &&
      Boolean(order?.payment.paymentSessionId);
    expect(stillPending).toBe(true);

    expect(paymentAmountLabel(!stillPending)).toBe("Amount");
    expect(paymentAmountLabel(!stillPending)).not.toContain("paid");
  });
});

describe("once the capture lands", () => {
  it("records the amount and is labelled as paid", async () => {
    const doc = await approvedButNotCaptured();

    // What PAYMENT.CAPTURE.COMPLETED does — the event that never arrived
    // for the live order because CHECKOUT.ORDER.APPROVED was not
    // subscribed, so no capture was ever triggered.
    await applyCheckoutPaid(doc, {
      eventId: "WH-CAPTURE-TEST",
      sessionId: "85N33701GC591621L",
      paymentIntentId: null,
      amountTotal: 50,
      paidAtMs: Date.now(),
      source: "webhook",
    });

    const order = await getOrderByNumber(doc.orderNumber);
    expect(order?.status).toBe(OrderStatus.PAID);
    expect(order?.payment.amountReceived).toBe(0.5);
    expect(order?.payment.paidAt).toBeTruthy();

    const stillPending =
      order?.status === OrderStatus.PAYMENT_PENDING &&
      Boolean(order?.payment.paymentSessionId);
    expect(paymentAmountLabel(!stillPending)).toBe("Amount paid");
  });
});

describe("the label rule", () => {
  it("claims payment only when confirmed", () => {
    expect(paymentAmountLabel(true)).toBe("Amount paid");
    expect(paymentAmountLabel(false)).toBe("Amount");
  });
});

describe("Stripe is unaffected", () => {
  it("still settles and labels a Stripe payment exactly as before", async () => {
    const doc = await createOrder({
      status: OrderStatus.PAYMENT_PENDING,
      payment: {
        gateway: PaymentGatewayKey.STRIPE,
        stripeSessionId: "cs_test_unchanged",
        status: OrderStatus.PAYMENT_PENDING,
      },
    });

    await applyCheckoutPaid(doc, {
      eventId: "evt_stripe_unchanged",
      sessionId: "cs_test_unchanged",
      paymentIntentId: "pi_unchanged",
      amountTotal: 15000,
      paidAtMs: Date.now(),
      source: "webhook",
    });

    const order = await getOrderByNumber(doc.orderNumber);
    expect(order?.status).toBe(OrderStatus.PAID);
    expect(order?.payment.gateway).toBe(PaymentGatewayKey.STRIPE);
    expect(order?.payment.amountReceived).toBe(150);
    expect(paymentAmountLabel(true)).toBe("Amount paid");
  });

  it("keeps a pending Stripe order pending, same as PayPal", async () => {
    const doc = await createOrder({
      status: OrderStatus.PAYMENT_PENDING,
      payment: {
        gateway: PaymentGatewayKey.STRIPE,
        stripeSessionId: "cs_test_pending",
        status: OrderStatus.PAYMENT_PENDING,
      },
    });

    const order = await getOrderByNumber(doc.orderNumber);
    expect(order?.status).toBe(OrderStatus.PAYMENT_PENDING);
    expect(order?.payment.amountReceived ?? null).toBeNull();
  });
});

/** Guards the field name the page reads, which is not the field the
 *  document stores — `stripeSessionId` surfaces as `paymentSessionId`. */
describe("the session id the page checks", () => {
  it("is exposed on the DTO", async () => {
    const doc = await approvedButNotCaptured();
    const order = await getOrderByNumber(doc.orderNumber);
    expect(order?.payment.paymentSessionId).toBe("85N33701GC591621L");
    expect(new Types.ObjectId(order!.id).toString()).toBe(String(doc._id));
  });
});
