import { beforeEach, describe, expect, it } from "vitest";

import { AuditAction, OrderStatus } from "@/lib/constants/enums";
import { AuditLog, Order } from "@/server/db/models";
import { processStripeEvent } from "@/server/services/webhook.service";
import {
  asyncPaymentFailedWebhook,
  completedWebhook,
  expiredWebhook,
  paymentIntentFailedWebhook,
} from "@/tests/fixtures/webhook.fixture";
import { createOrder as factoryCreateOrder } from "@/tests/factories/order.factory";
import { ensureMongo } from "@/tests/utils/db";

/**
 * Webhook processor — the most safety-critical surface in PayOps.
 *
 * Pin the invariants that the operations team relies on:
 *
 *   - "paid" is set exactly once, even under concurrent webhook delivery
 *   - the confirmation email is "claimed" via a conditional update so a
 *     duplicate delivery never double-mails the customer
 *   - failed / expired webhooks transition the order without overriding a
 *     prior PAID state
 *   - every received event leaves a WEBHOOK_RECEIVED audit row, and
 *     duplicates additionally leave WEBHOOK_DUPLICATE
 */

beforeEach(async () => {
  await ensureMongo();
});

describe("checkout.session.completed", () => {
  it("flips the matched order to PAID and records the receipt", async () => {
    const order = await factoryCreateOrder({
      payment: {
        status: OrderStatus.PAYMENT_PENDING,
        stripeSessionId: "cs_test_completed_1",
        processedWebhookEventIds: [],
      },
    });

    const event = completedWebhook({
      orderId: String(order._id),
      orderNumber: order.orderNumber,
      amount: 199.5,
    });

    const result = await processStripeEvent(event);

    expect(result).toMatchObject({ handled: true, duplicate: false });
    const updated = await Order.findById(order._id);
    expect(updated?.status).toBe(OrderStatus.PAID);
    expect(updated?.payment.status).toBe(OrderStatus.PAID);
    expect(updated?.payment.amountReceived).toBe(199.5);
    expect(updated?.payment.paidAt).toBeInstanceOf(Date);
    expect(updated?.payment.processedWebhookEventIds).toContain(event.eventId);
  });

  it("is idempotent: the second delivery is a no-op duplicate", async () => {
    const order = await factoryCreateOrder({});
    const event = completedWebhook({
      orderId: String(order._id),
      orderNumber: order.orderNumber,
    });

    const first = await processStripeEvent(event);
    const second = await processStripeEvent(event);

    expect(first).toMatchObject({ handled: true, duplicate: false });
    expect(second).toMatchObject({ handled: true, duplicate: true });

    const updated = await Order.findById(order._id);
    expect(updated?.payment.processedWebhookEventIds).toEqual([event.eventId]);
    expect(
      await AuditLog.countDocuments({ action: AuditAction.PAYMENT_SUCCEEDED }),
    ).toBe(1);
  });

  it("claims the confirmation email exactly once even on concurrent delivery", async () => {
    const order = await factoryCreateOrder({});
    const event = completedWebhook({
      orderId: String(order._id),
      orderNumber: order.orderNumber,
    });

    // Two concurrent worker fires for the same event.
    const [a, b] = await Promise.all([
      processStripeEvent(event),
      processStripeEvent(event),
    ]);
    expect([a.duplicate, b.duplicate].sort()).toEqual([false, true]);

    const updated = await Order.findById(order._id);
    expect(updated?.payment.confirmationEmailSentAt).toBeInstanceOf(Date);
    // No SMTP in tests — should have logged an EMAIL_FAILED row.
    expect(
      await AuditLog.countDocuments({ action: AuditAction.EMAIL_FAILED }),
    ).toBe(1);
  });

  it("retries the confirmation email when a duplicate event arrives but the previous send failed", async () => {
    // Simulate the state we'd reach if delivery #1 marked the order PAID
    // but the SMTP send failed and rolled back the email claim. Delivery
    // #2 should detect the gap and re-attempt the send rather than
    // silently no-op.
    const order = await factoryCreateOrder({
      status: OrderStatus.PAID,
      payment: {
        status: OrderStatus.PAID,
        paidAt: new Date(),
        amountReceived: 100,
        // The event id is already in the array from delivery #1.
        processedWebhookEventIds: ["evt_test_retry_email"],
        confirmationEmailSentAt: null,
      },
    });

    const event = completedWebhook({
      orderId: String(order._id),
      orderNumber: order.orderNumber,
    });
    event.eventId = "evt_test_retry_email";

    const before = await AuditLog.countDocuments({
      action: AuditAction.EMAIL_FAILED,
    });
    const result = await processStripeEvent(event);

    expect(result).toMatchObject({
      handled: true,
      duplicate: true,
      orderId: String(order._id),
    });

    // No SMTP configured → another EMAIL_FAILED row was written (rather
    // than silently skipping the retry).
    const after = await AuditLog.countDocuments({
      action: AuditAction.EMAIL_FAILED,
    });
    expect(after - before).toBe(1);

    // The order's confirmationEmailSentAt is now stamped (claimed) so a
    // subsequent duplicate won't re-attempt.
    const updated = await Order.findById(order._id);
    expect(updated?.payment.confirmationEmailSentAt).toBeInstanceOf(Date);
  });

  it("returns order_not_found when no matching order exists", async () => {
    const event = completedWebhook({
      orderId: "507f1f77bcf86cd799439099",
      orderNumber: "MISSING",
    });
    const result = await processStripeEvent(event);
    expect(result).toEqual({
      handled: false,
      duplicate: false,
      reason: "order_not_found",
    });
  });

  it("matches orders by stripeSessionId when the client_reference_id is absent", async () => {
    const order = await factoryCreateOrder({
      payment: {
        status: OrderStatus.PAYMENT_PENDING,
        stripeSessionId: "cs_test_lookup_by_session",
        processedWebhookEventIds: [],
      },
    });

    const event = completedWebhook({
      orderId: "BOGUS",
      orderNumber: order.orderNumber,
      sessionId: "cs_test_lookup_by_session",
    });

    // The normalised event has no client_reference_id field — the
    // session id alone drives the lookup.
    const result = await processStripeEvent(event);
    expect(result).toMatchObject({
      handled: true,
      duplicate: false,
      orderId: String(order._id),
    });
  });
});

describe("checkout.session.expired", () => {
  it("transitions a pending order to EXPIRED", async () => {
    const order = await factoryCreateOrder({});
    const event = expiredWebhook({
      orderId: String(order._id),
      orderNumber: order.orderNumber,
    });
    const result = await processStripeEvent(event);

    expect(result).toMatchObject({ handled: true, duplicate: false });
    const updated = await Order.findById(order._id);
    expect(updated?.status).toBe(OrderStatus.EXPIRED);
  });

  it("does NOT overwrite a paid order", async () => {
    const order = await factoryCreateOrder({
      status: OrderStatus.PAID,
      payment: {
        status: OrderStatus.PAID,
        paidAt: new Date(),
        amountReceived: 100,
        processedWebhookEventIds: [],
      },
    });
    const event = expiredWebhook({
      orderId: String(order._id),
      orderNumber: order.orderNumber,
    });
    const result = await processStripeEvent(event);
    expect(result.duplicate).toBe(true);

    const updated = await Order.findById(order._id);
    expect(updated?.status).toBe(OrderStatus.PAID);
  });
});

describe("failed payments", () => {
  it("checkout.session.async_payment_failed marks order FAILED", async () => {
    const order = await factoryCreateOrder({});
    const event = asyncPaymentFailedWebhook({
      orderId: String(order._id),
      orderNumber: order.orderNumber,
    });
    const result = await processStripeEvent(event);
    expect(result).toMatchObject({ handled: true, duplicate: false });
    const updated = await Order.findById(order._id);
    expect(updated?.status).toBe(OrderStatus.FAILED);
  });

  it("payment_intent.payment_failed finds the order by paymentIntentId", async () => {
    const order = await factoryCreateOrder({
      payment: {
        status: OrderStatus.PAYMENT_PENDING,
        paymentIntentId: "pi_test_lookup",
        processedWebhookEventIds: [],
      },
    });
    const event = paymentIntentFailedWebhook({
      paymentIntentId: "pi_test_lookup",
      message: "Insufficient funds",
    });
    const result = await processStripeEvent(event);
    expect(result.handled).toBe(true);

    const updated = await Order.findById(order._id);
    expect(updated?.status).toBe(OrderStatus.FAILED);
    expect(updated?.payment.failureReason).toMatch(/Insufficient funds/);
  });
});

describe("audit trail", () => {
  it("always records a WEBHOOK_RECEIVED row for every delivery", async () => {
    const order = await factoryCreateOrder({});
    const event = completedWebhook({
      orderId: String(order._id),
      orderNumber: order.orderNumber,
    });
    await processStripeEvent(event);
    await processStripeEvent(event);
    expect(
      await AuditLog.countDocuments({
        action: AuditAction.WEBHOOK_RECEIVED,
        entityId: event.eventId,
      }),
    ).toBe(2);
    expect(
      await AuditLog.countDocuments({
        action: AuditAction.WEBHOOK_DUPLICATE,
        entityId: event.eventId,
      }),
    ).toBe(1);
  });
});
