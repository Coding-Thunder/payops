import { beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";

import {
  AuditAction,
  DisputeStatus,
  OrderStatus,
  PaymentGatewayKey,
  RecordState,
} from "@/lib/constants/enums";
import {
  AuditLog,
  Dispute,
  Order,
  Organization,
} from "@/server/db/models";
import { processGatewayEvent } from "@/server/services/webhook.service";
import {
  disputeClosedWebhook,
  disputeCreatedWebhook,
  disputeUpdatedWebhook,
  refundCreatedWebhook,
} from "@/tests/fixtures/webhook.fixture";
import { createOrder as factoryCreateOrder } from "@/tests/factories/order.factory";
import { ensureMongo } from "@/tests/utils/db";

/**
 * REGRESSION TESTS FOR A REAL DEFECT FOUND IN ADVERSARIAL REVIEW.
 *
 * `charge.dispute.created` and `charge.refunded` resolve their target order
 * through `findOrderByPaymentIntent`, which enforces the cross-organization
 * rule. But `charge.dispute.updated`, `charge.dispute.closed` and
 * `charge.dispute.funds_withdrawn` resolved theirs with a bare
 * `Dispute.findOne({ gatewayDisputeId })` — and `gatewayDisputeId` is a
 * value the PAYLOAD supplies.
 *
 * So a delivery to one brand's Stripe endpoint could drive ANOTHER brand's
 * chargeback to WON or LOST, stamp its closedAt, and write to its audit
 * trail — purely because the payload named that dispute. Two tenants made
 * this unlikely; a third makes it a real exposure.
 *
 * The rule these tests pin, for every dispute event type:
 *   - a delivery to the OWNING tenant's endpoint is applied
 *   - a delivery to ANOTHER tenant's endpoint changes NOTHING and writes a
 *     `cross_organization_event` audit row
 *   - the deployment-level endpoint (null organization) keeps resolving the
 *     DEFAULT organization's disputes exactly as it always has
 */

let defaultOrg: Types.ObjectId;
let otherOrg: Types.ObjectId;

async function makeOrg(slug: string, isDefault: boolean) {
  const doc = await Organization.create({
    slug,
    name: slug,
    brandName: `${slug} brand`,
    isDefault,
    payments: { provider: PaymentGatewayKey.STRIPE },
  });
  return doc._id as Types.ObjectId;
}

async function seedPaidOrder(
  organizationId: Types.ObjectId,
  intentId: string,
) {
  return factoryCreateOrder({
    organizationId,
    status: OrderStatus.PAID,
    payment: {
      status: OrderStatus.PAID,
      paymentIntentId: intentId,
      stripeSessionId: `cs_test_paid_${intentId}`,
      paidAt: new Date(),
      amountReceived: 199.5,
      processedWebhookEventIds: [],
    },
  });
}

beforeEach(async () => {
  await ensureMongo();
  defaultOrg = await makeOrg("rentalconfirmation", true);
  otherOrg = await makeOrg("globevista", false);
});

/** Open a dispute against `org`'s order, delivered to `org`'s own endpoint. */
async function openDisputeFor(org: Types.ObjectId, intentId: string) {
  const order = await seedPaidOrder(org, intentId);
  const created = disputeCreatedWebhook({
    paymentIntentId: intentId,
    amount: 199.5,
    reason: "fraudulent",
  });
  await processGatewayEvent(created, String(org));
  const dispute = await Dispute.findOne({
    gatewayDisputeId: created.dispute!.gatewayDisputeId,
  }).lean();
  if (!dispute) throw new Error("dispute was not created");
  return {
    order,
    dispute,
    intentId,
    gatewayDisputeId: created.dispute!.gatewayDisputeId,
  };
}

async function crossOrgAuditRows() {
  return AuditLog.find({
    action: AuditAction.WEBHOOK_FAILED,
    "metadata.reason": "cross_organization_event",
  }).lean();
}

describe("dispute.created stamps the owning organization", () => {
  it("attributes the Dispute row to the order's organization", async () => {
    const { dispute } = await openDisputeFor(otherOrg, `pi_x_${Date.now()}`);
    // Without this stamp a null-organization dispute is visible ONLY to the
    // default organization — so GlobeVista could not see its own chargeback
    // while RentalConfirmation could.
    expect(String(dispute.organizationId)).toBe(String(otherOrg));
  });
});

describe("dispute.updated obeys the cross-organization rule", () => {
  it("applies an update delivered to the OWNING tenant's endpoint", async () => {
    const { gatewayDisputeId, intentId } = await openDisputeFor(
      otherOrg,
      `pi_own_${Date.now()}`,
    );

    await processGatewayEvent(
      disputeUpdatedWebhook({
        paymentIntentId: intentId,
        gatewayDisputeId,
        status: DisputeStatus.UNDER_REVIEW,
      }),
      String(otherOrg),
    );

    const after = await Dispute.findOne({ gatewayDisputeId }).lean();
    expect(after?.status).toBe(DisputeStatus.UNDER_REVIEW);
  });

  it("REFUSES an update delivered to ANOTHER tenant's endpoint", async () => {
    const { gatewayDisputeId, dispute, intentId } = await openDisputeFor(
      otherOrg,
      `pi_victim_${Date.now()}`,
    );
    const before = JSON.stringify(
      await Dispute.findOne({ gatewayDisputeId }).lean(),
    );

    const result = await processGatewayEvent(
      disputeUpdatedWebhook({
        paymentIntentId: intentId,
        gatewayDisputeId,
        status: DisputeStatus.UNDER_REVIEW,
      }),
      // Delivered to the DEFAULT organization's endpoint — a different tenant.
      String(defaultOrg),
    );

    expect(result.handled).toBe(false);
    // Byte-identical: not the status, not updatedAt, not the event-id list.
    const after = JSON.stringify(
      await Dispute.findOne({ gatewayDisputeId }).lean(),
    );
    expect(after).toBe(before);
    expect(String(dispute.status)).toBe(DisputeStatus.NEEDS_RESPONSE);

    const audits = await crossOrgAuditRows();
    expect(audits.length).toBeGreaterThan(0);
    expect(audits.at(-1)?.metadata).toMatchObject({
      reason: "cross_organization_event",
    });
  });
});

describe("dispute.closed obeys the cross-organization rule", () => {
  it("REFUSES a close delivered to ANOTHER tenant's endpoint", async () => {
    const { gatewayDisputeId, intentId } = await openDisputeFor(
      otherOrg,
      `pi_close_${Date.now()}`,
    );

    const result = await processGatewayEvent(
      disputeClosedWebhook({
        paymentIntentId: intentId,
        gatewayDisputeId,
        outcome: "LOST",
      }),
      String(defaultOrg),
    );

    expect(result.handled).toBe(false);
    const after = await Dispute.findOne({ gatewayDisputeId }).lean();
    // The single most damaging outcome this guard prevents: one tenant's
    // endpoint marking another tenant's chargeback LOST.
    expect(after?.status).toBe(DisputeStatus.NEEDS_RESPONSE);
    expect(after?.closedAt ?? null).toBeNull();
    expect(after?.outcome ?? null).toBeNull();
  });

  it("applies a close delivered to the OWNING tenant's endpoint", async () => {
    const { gatewayDisputeId, intentId } = await openDisputeFor(
      otherOrg,
      `pi_close_ok_${Date.now()}`,
    );

    await processGatewayEvent(
      disputeClosedWebhook({
        paymentIntentId: intentId,
        gatewayDisputeId,
        outcome: "WON",
      }),
      String(otherOrg),
    );

    const after = await Dispute.findOne({ gatewayDisputeId }).lean();
    expect(after?.status).toBe(DisputeStatus.WON);
    expect(after?.closedAt).toBeTruthy();
  });
});

describe("refund.created obeys the cross-organization rule", () => {
  it("REFUSES a refund delivered to ANOTHER tenant's endpoint", async () => {
    const intentId = `pi_refund_${Date.now()}`;
    const order = await seedPaidOrder(otherOrg, intentId);

    const result = await processGatewayEvent(
      refundCreatedWebhook({
        paymentIntentId: intentId,
        amount: 50,
        totalRefunded: 50,
      }),
      String(defaultOrg),
    );

    expect(result.handled).toBe(false);
    const after = await Order.findById(order._id).lean();
    // A refund landing on the wrong tenant's books would misstate revenue
    // for both brands.
    expect(after?.refundedAmount ?? 0).toBe(0);
  });
});

describe("the deployment-level endpoint is unchanged for the incumbent", () => {
  it("still resolves the DEFAULT organization's disputes with a null endpoint", async () => {
    const intentId = `pi_default_${Date.now()}`;
    await seedPaidOrder(defaultOrg, intentId);

    const created = disputeCreatedWebhook({
      paymentIntentId: intentId,
      amount: 199.5,
      reason: "fraudulent",
    });
    // organizationId null == the deployment-level /api/webhooks/stripe route,
    // which is what RentalConfirmation's Stripe account still posts to.
    const openedResult = await processGatewayEvent(created, null);
    expect(openedResult.handled).toBe(true);

    const closed = await processGatewayEvent(
      disputeClosedWebhook({
        paymentIntentId: intentId,
        gatewayDisputeId: created.dispute!.gatewayDisputeId,
        outcome: "WON",
      }),
      null,
    );
    expect(closed.handled).toBe(true);

    const after = await Dispute.findOne({
      gatewayDisputeId: created.dispute!.gatewayDisputeId,
    }).lean();
    expect(after?.status).toBe(DisputeStatus.WON);
  });

  it("still resolves an UNATTRIBUTED pre-migration order with a null endpoint", async () => {
    const intentId = `pi_legacy_${Date.now()}`;
    // No organizationId at all — every order written before the tenancy
    // migration looks like this.
    const order = await factoryCreateOrder({
      status: OrderStatus.PAID,
      payment: {
        status: OrderStatus.PAID,
        paymentIntentId: intentId,
        stripeSessionId: `cs_legacy_${intentId}`,
        paidAt: new Date(),
        amountReceived: 199.5,
        processedWebhookEventIds: [],
      },
    });
    await Order.updateOne(
      { _id: order._id },
      { $unset: { organizationId: "" } },
    );

    const result = await processGatewayEvent(
      disputeCreatedWebhook({
        paymentIntentId: intentId,
        amount: 199.5,
        reason: "fraudulent",
      }),
      null,
    );
    expect(result.handled).toBe(true);
  });
});

describe("organization status is irrelevant to the guard", () => {
  it("a DISABLED organization's dispute is still protected from other tenants", async () => {
    const { gatewayDisputeId, intentId } = await openDisputeFor(
      otherOrg,
      `pi_disabled_${Date.now()}`,
    );
    await Organization.updateOne(
      { _id: otherOrg },
      { $set: { status: RecordState.DISABLED } },
    );

    const result = await processGatewayEvent(
      disputeClosedWebhook({
        paymentIntentId: intentId,
        gatewayDisputeId,
        outcome: "LOST",
      }),
      String(defaultOrg),
    );
    expect(result.handled).toBe(false);
    const after = await Dispute.findOne({ gatewayDisputeId }).lean();
    expect(after?.status).toBe(DisputeStatus.NEEDS_RESPONSE);
  });
});
