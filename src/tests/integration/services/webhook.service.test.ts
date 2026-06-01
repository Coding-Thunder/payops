import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuditAction, OrderStatus } from "@/lib/constants/enums";
import {
  AuditLog,
  Order,
  PendingEmail,
  PendingEmailStatus,
} from "@/server/db/models";
import { drainOnePendingEmail } from "@/server/services/email-outbox.service";
import * as emailService from "@/server/services/email.service";
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
 * Webhook processor, the most safety-critical surface in TraceTxn.
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

  it("enqueues exactly one PendingEmail row on concurrent delivery + drainer stamps the order", async () => {
    // New outbox contract (replaces the old in-tx claim):
    //   1. processStripeEvent enqueues one PendingEmail row inside
    //      the same tx as the PAID flip. The duplicate delivery is a
    //      no-op, no second row.
    //   2. The drainer sends the email + stamps the order's
    //      `confirmationEmailSentAt`. SMTP isn't configured in tests,
    //      so the send is treated as a soft no-op (returns id: null,
    //      writes EMAIL_FAILED audit) and the row resolves as SENT.
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

    // Before the drainer runs, the order is PAID but the email hasn't
    // been sent yet, exactly one outbox row is sitting there waiting.
    const beforeDrain = await Order.findById(order._id);
    expect(beforeDrain?.status).toBe(OrderStatus.PAID);
    expect(beforeDrain?.payment.confirmationEmailSentAt).toBeNull();

    const pendingRows = await PendingEmail.find({ orderId: order._id });
    expect(pendingRows).toHaveLength(1);
    expect(pendingRows[0].status).toBe(PendingEmailStatus.PENDING);

    // Drain, the outbox picks up the row, calls sendPaymentConfirmation
    // (which soft-fails with no SMTP), then conditionally stamps the
    // order. The row resolves as SENT because the send returned cleanly.
    const drained = await drainOnePendingEmail();
    expect(drained?.status).toBe(PendingEmailStatus.SENT);

    const afterDrain = await Order.findById(order._id);
    expect(afterDrain?.payment.confirmationEmailSentAt).toBeInstanceOf(Date);

    // The no-SMTP path writes one EMAIL_FAILED audit row per send
    // attempt. Exactly one, never doubled by the duplicate webhook.
    expect(
      await AuditLog.countDocuments({ action: AuditAction.EMAIL_FAILED }),
    ).toBe(1);

    // Idempotency: a second drain finds no work.
    const secondDrain = await drainOnePendingEmail();
    expect(secondDrain).toBeNull();
  });

  it("retries with backoff when the send throws + caps at MAX_ATTEMPTS=5", async () => {
    // New outbox retry contract (replaces the old duplicate-webhook
    // retry path):
    //   - A failing send leaves the row PENDING with attempts++ and
    //     nextAttemptAt pushed into the future.
    //   - After MAX_ATTEMPTS retries, the row resolves as FAILED.
    // Verified by making sendPaymentConfirmationEmail throw on every
    // call and draining the row repeatedly.
    const sendSpy = vi
      .spyOn(emailService, "sendPaymentConfirmationEmail")
      .mockRejectedValue(new Error("smtp: connection refused"));

    const order = await factoryCreateOrder({});
    const event = completedWebhook({
      orderId: String(order._id),
      orderNumber: order.orderNumber,
    });
    await processStripeEvent(event);

    const enqueued = await PendingEmail.findOne({ orderId: order._id });
    expect(enqueued?.status).toBe(PendingEmailStatus.PENDING);
    expect(enqueued?.attempts).toBe(0);

    // First drain, fails, row goes back to PENDING with backoff.
    const r1 = await drainOnePendingEmail();
    expect(r1?.status).toBe(PendingEmailStatus.PENDING);
    const afterFirst = await PendingEmail.findById(enqueued?._id);
    expect(afterFirst?.attempts).toBe(1);
    expect(afterFirst?.lastError).toMatch(/connection refused/);
    expect(afterFirst?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    // To exercise the retry loop without waiting through real backoff,
    // bump nextAttemptAt back to the past after each failure.
    async function rewindAndDrain() {
      await PendingEmail.updateOne(
        { _id: enqueued?._id },
        { $set: { nextAttemptAt: new Date(Date.now() - 1000) } },
      );
      return drainOnePendingEmail();
    }

    // attempts 2, 3, 4 → still PENDING after each failure
    for (let i = 2; i <= 4; i += 1) {
      const r = await rewindAndDrain();
      expect(r?.status).toBe(PendingEmailStatus.PENDING);
      const row = await PendingEmail.findById(enqueued?._id);
      expect(row?.attempts).toBe(i);
    }

    // 5th attempt, caps out, row resolves as FAILED.
    const final = await rewindAndDrain();
    expect(final?.status).toBe(PendingEmailStatus.FAILED);
    const dead = await PendingEmail.findById(enqueued?._id);
    expect(dead?.attempts).toBe(5);
    expect(dead?.status).toBe(PendingEmailStatus.FAILED);
    expect(dead?.lastError).toMatch(/connection refused/);

    // The order's confirmationEmailSentAt remains null, the outbox
    // never stamped it because every send failed.
    const orderAfter = await Order.findById(order._id);
    expect(orderAfter?.payment.confirmationEmailSentAt).toBeNull();

    sendSpy.mockRestore();
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

    // The normalised event has no client_reference_id field, the
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
