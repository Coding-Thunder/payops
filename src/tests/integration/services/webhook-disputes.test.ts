import { beforeEach, describe, expect, it } from "vitest";

import {
  AuditAction,
  DisputeOutcome,
  DisputeStatus,
  OrderStatus,
} from "@/lib/constants/enums";
import { AuditLog, Dispute, Order } from "@/server/db/models";
import { processStripeEvent } from "@/server/services/webhook.service";
import {
  disputeClosedWebhook,
  disputeCreatedWebhook,
  disputeUpdatedWebhook,
  refundCreatedWebhook,
} from "@/tests/fixtures/webhook.fixture";
import { createOrder as factoryCreateOrder } from "@/tests/factories/order.factory";
import { ensureMongo } from "@/tests/utils/db";

/**
 * Dispute + refund webhook handlers, pins the operational invariants
 * the disputes team relies on:
 *
 *   - charge.dispute.created persists a Dispute, points the order at it,
 *     auto-flags risk, and emits a DISPUTE_CREATED audit row
 *   - duplicate deliveries are idempotent on the per-dispute event-id list
 *   - charge.dispute.closed promotes the outcome and stamps closedAt
 *     without clearing the risk flag (operator action)
 *   - charge.refunded ratchets the order's refundedAmount via the
 *     charge's cumulative amount_refunded, never backwards
 */

beforeEach(async () => {
  await ensureMongo();
});

async function seedPaidOrderWithIntent(intentId: string) {
  return factoryCreateOrder({
    status: OrderStatus.PAID,
    payment: {
      status: OrderStatus.PAID,
      paymentIntentId: intentId,
      stripeSessionId: `cs_test_paid_${Date.now()}`,
      paidAt: new Date(),
      amountReceived: 199.5,
      processedWebhookEventIds: [],
    },
  });
}

describe("charge.dispute.created", () => {
  it("persists the dispute, points the order at it, and auto-flags risk", async () => {
    const intentId = `pi_test_dispute_${Date.now()}`;
    const order = await seedPaidOrderWithIntent(intentId);

    const event = disputeCreatedWebhook({
      paymentIntentId: intentId,
      amount: 199.5,
      reason: "fraudulent",
    });
    const result = await processStripeEvent(event);

    expect(result).toMatchObject({ handled: true, duplicate: false });

    // Persisted Dispute doc carries the full evidence-bundle fields.
    const dispute = await Dispute.findOne({
      gatewayDisputeId: event.dispute!.gatewayDisputeId,
    }).lean();
    expect(dispute).toBeTruthy();
    expect(dispute?.status).toBe(DisputeStatus.NEEDS_RESPONSE);
    expect(dispute?.outcome).toBeNull();
    expect(dispute?.amount).toBe(199.5);
    expect(dispute?.evidenceDueAt).toBeInstanceOf(Date);
    expect(dispute?.processedWebhookEventIds).toContain(event.eventId);

    // Order denormalised pointer + risk auto-flag.
    const refreshed = await Order.findById(order._id).lean();
    expect(refreshed?.dispute?.status).toBe(DisputeStatus.NEEDS_RESPONSE);
    expect(String(refreshed?.dispute?.currentDisputeId)).toBe(
      String(dispute?._id),
    );
    expect(refreshed?.dispute?.openedAt).toBeInstanceOf(Date);
    expect(refreshed?.dispute?.outcome).toBeNull();
    // Auto-flag runs as a system actor.
    expect(refreshed?.risk?.flagged).toBe(true);
    expect(refreshed?.risk?.flaggedAt).toBeInstanceOf(Date);
    expect(refreshed?.risk?.flaggedBy?.userId).toBeNull();
    expect(refreshed?.risk?.flaggedNote).toContain("Chargeback opened");

    // Audit row written.
    const audits = await AuditLog.find({
      action: AuditAction.DISPUTE_CREATED,
    }).lean();
    expect(audits).toHaveLength(1);
  });

  it("is idempotent on a re-delivered created event", async () => {
    const intentId = `pi_test_dispute_dup_${Date.now()}`;
    const order = await seedPaidOrderWithIntent(intentId);

    const event = disputeCreatedWebhook({
      paymentIntentId: intentId,
      gatewayDisputeId: "du_test_dup_1",
    });

    const first = await processStripeEvent(event);
    const second = await processStripeEvent(event);

    expect(first).toMatchObject({ handled: true, duplicate: false });
    expect(second).toMatchObject({ handled: true, duplicate: true });

    const disputes = await Dispute.find({ orderId: order._id }).lean();
    expect(disputes).toHaveLength(1);
    expect(disputes[0]?.processedWebhookEventIds).toEqual([event.eventId]);
  });

  it("returns order_not_found when the payment intent does not match any order", async () => {
    const event = disputeCreatedWebhook({
      paymentIntentId: "pi_unknown_intent",
      gatewayDisputeId: "du_test_orphan",
    });
    const result = await processStripeEvent(event);
    expect(result).toMatchObject({
      handled: false,
      reason: "order_not_found",
    });
    const disputes = await Dispute.find({}).lean();
    expect(disputes).toHaveLength(0);
  });
});

describe("charge.dispute.updated", () => {
  it("moves the dispute status forward and refreshes the order pointer", async () => {
    const intentId = `pi_test_dispute_upd_${Date.now()}`;
    await seedPaidOrderWithIntent(intentId);
    const created = disputeCreatedWebhook({
      paymentIntentId: intentId,
      gatewayDisputeId: "du_test_upd_1",
    });
    await processStripeEvent(created);

    const updated = disputeUpdatedWebhook({
      paymentIntentId: intentId,
      gatewayDisputeId: "du_test_upd_1",
      status: DisputeStatus.UNDER_REVIEW,
    });
    const res = await processStripeEvent(updated);
    expect(res).toMatchObject({ handled: true, duplicate: false });

    const refreshed = await Dispute.findOne({
      gatewayDisputeId: "du_test_upd_1",
    }).lean();
    expect(refreshed?.status).toBe(DisputeStatus.UNDER_REVIEW);
    expect(refreshed?.processedWebhookEventIds).toContain(updated.eventId);
  });

  it("materialises a dispute when an update arrives before the create event", async () => {
    const intentId = `pi_test_dispute_oop_${Date.now()}`;
    await seedPaidOrderWithIntent(intentId);

    // Update first, no Dispute doc exists yet.
    const updated = disputeUpdatedWebhook({
      paymentIntentId: intentId,
      gatewayDisputeId: "du_test_oop_1",
      status: DisputeStatus.UNDER_REVIEW,
    });
    const res = await processStripeEvent(updated);
    expect(res).toMatchObject({ handled: true, duplicate: false });

    const dispute = await Dispute.findOne({
      gatewayDisputeId: "du_test_oop_1",
    }).lean();
    expect(dispute).toBeTruthy();
  });
});

describe("charge.dispute.closed", () => {
  it("promotes the dispute to a terminal outcome and stamps closedAt", async () => {
    const intentId = `pi_test_dispute_closed_${Date.now()}`;
    const order = await seedPaidOrderWithIntent(intentId);
    const created = disputeCreatedWebhook({
      paymentIntentId: intentId,
      gatewayDisputeId: "du_test_close_1",
    });
    await processStripeEvent(created);

    const closed = disputeClosedWebhook({
      paymentIntentId: intentId,
      gatewayDisputeId: "du_test_close_1",
      outcome: "LOST",
    });
    const res = await processStripeEvent(closed);
    expect(res).toMatchObject({ handled: true, duplicate: false });

    const dispute = await Dispute.findOne({
      gatewayDisputeId: "du_test_close_1",
    }).lean();
    expect(dispute?.outcome).toBe(DisputeOutcome.LOST);
    expect(dispute?.status).toBe(DisputeStatus.LOST);
    expect(dispute?.closedAt).toBeInstanceOf(Date);

    // Order pointer mirrors the outcome but risk.flagged stays, that's
    // an explicit ops action.
    const refreshed = await Order.findById(order._id).lean();
    expect(refreshed?.dispute?.outcome).toBe(DisputeOutcome.LOST);
    expect(refreshed?.dispute?.closedAt).toBeInstanceOf(Date);
    expect(refreshed?.risk?.flagged).toBe(true);
  });

  it("is idempotent on duplicate close deliveries", async () => {
    const intentId = `pi_test_dispute_closed_dup_${Date.now()}`;
    await seedPaidOrderWithIntent(intentId);
    await processStripeEvent(
      disputeCreatedWebhook({
        paymentIntentId: intentId,
        gatewayDisputeId: "du_test_close_dup",
      }),
    );
    const closed = disputeClosedWebhook({
      paymentIntentId: intentId,
      gatewayDisputeId: "du_test_close_dup",
      outcome: "WON",
    });
    const first = await processStripeEvent(closed);
    const second = await processStripeEvent(closed);
    expect(first).toMatchObject({ handled: true, duplicate: false });
    expect(second).toMatchObject({ handled: true, duplicate: true });
  });

  it("materialises the dispute when close arrives before create", async () => {
    const intentId = `pi_test_dispute_close_first_${Date.now()}`;
    await seedPaidOrderWithIntent(intentId);
    const closed = disputeClosedWebhook({
      paymentIntentId: intentId,
      gatewayDisputeId: "du_test_close_first",
      outcome: "WON",
    });
    const res = await processStripeEvent(closed);
    expect(res).toMatchObject({ handled: true });
    const dispute = await Dispute.findOne({
      gatewayDisputeId: "du_test_close_first",
    }).lean();
    expect(dispute?.status).toBe(DisputeStatus.WON);
    expect(dispute?.outcome).toBe(DisputeOutcome.WON);
  });
});

describe("charge.refunded", () => {
  it("ratchets the order's refundedAmount and emits a REFUND_CREATED audit row", async () => {
    const intentId = `pi_test_refund_${Date.now()}`;
    const order = await seedPaidOrderWithIntent(intentId);

    const event = refundCreatedWebhook({
      paymentIntentId: intentId,
      amount: 50,
      totalRefunded: 50,
    });
    const result = await processStripeEvent(event);
    expect(result).toMatchObject({ handled: true, duplicate: false });

    const refreshed = await Order.findById(order._id).lean();
    expect(refreshed?.refundedAmount).toBe(50);
    expect(refreshed?.payment?.processedWebhookEventIds).toContain(
      event.eventId,
    );

    const audits = await AuditLog.find({
      action: AuditAction.REFUND_CREATED,
    }).lean();
    expect(audits).toHaveLength(1);
  });

  it("never ratchets refundedAmount backwards on out-of-order partial events", async () => {
    const intentId = `pi_test_refund_partial_${Date.now()}`;
    const order = await seedPaidOrderWithIntent(intentId);

    // Imagine Stripe delivered a $100 cumulative-refund event first, then
    // the $30 partial that came earlier, we should keep the $100.
    const big = refundCreatedWebhook({
      paymentIntentId: intentId,
      amount: 70,
      totalRefunded: 100,
    });
    await processStripeEvent(big);

    const partial = refundCreatedWebhook({
      paymentIntentId: intentId,
      amount: 30,
      totalRefunded: 30,
    });
    await processStripeEvent(partial);

    const refreshed = await Order.findById(order._id).lean();
    expect(refreshed?.refundedAmount).toBe(100);
  });

  it("is idempotent on a duplicate refund delivery", async () => {
    const intentId = `pi_test_refund_dup_${Date.now()}`;
    await seedPaidOrderWithIntent(intentId);
    const event = refundCreatedWebhook({
      paymentIntentId: intentId,
      amount: 25,
    });
    const first = await processStripeEvent(event);
    const second = await processStripeEvent(event);
    expect(first).toMatchObject({ handled: true, duplicate: false });
    expect(second).toMatchObject({ handled: true, duplicate: true });
  });
});
