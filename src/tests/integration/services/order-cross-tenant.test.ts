import { Types } from "mongoose";
import { beforeEach, describe, expect, it } from "vitest";

import {
  Currency,
  OrderStatus,
  RecordState,
  UserRole,
} from "@/lib/constants/enums";
import { NotFoundError } from "@/lib/errors";
import { Order } from "@/server/db/models";
import {
  archiveOrder,
  deleteOrders,
  getOrderById,
  listOrders,
  reconcileOrderPayment,
  regeneratePaymentLink,
  setOrderRiskFlag,
  updateOrderCustomer,
} from "@/server/services/order.service";
import { ensureMongo, resetDatabase } from "@/tests/utils/db";

/**
 * Pass 5a, order-service cross-tenant write/read guard.
 *
 * The Phase-A audit (risk #4.1) called out 14+ `Order.findById` call
 * sites that didn't pin orgId. The mitigation today was the
 * `createdBy.userId` check for STAFF, which let any ADMIN with
 * ORDER_VIEW_ALL through to ANY tenant's order by id.
 *
 * This test fixture creates an order owned by Org A and probes every
 * affected service entry-point as an ADMIN of Org B. All must return
 * `NotFoundError` (preferred, masks existence) or otherwise refuse.
 */

beforeEach(async () => {
  await ensureMongo();
  await resetDatabase();
});

const ORG_A = new Types.ObjectId().toString();
const ORG_B = new Types.ObjectId().toString();

async function seedOrgAOrder(): Promise<{ orderId: string; ownerId: string }> {
  const ownerId = new Types.ObjectId();
  const order = await Order.create({
    orgId: new Types.ObjectId(ORG_A),
    orderNumber: "ORGA-XCT-1",
    status: OrderStatus.PAYMENT_PENDING,
    state: RecordState.ACTIVE,
    customer: { name: "C", email: "c@x.test", phone: "+1" },
    lineItems: [
      {
        itemTypeKey: "service_visit",
        name: "Cross-tenant test order",
        quantity: 1,
        unitPrice: 100,
        total: 100,
        attributes: {},
      },
    ],
    pricing: { amount: 100, currency: "USD" as Currency },
    payment: {
      status: OrderStatus.PAYMENT_PENDING,
      stripeSessionId: "cs_orgA_xct",
      processedWebhookEventIds: [],
    },
    createdBy: {
      userId: ownerId,
      name: "OrgA Founder",
      email: "founder@orga.test",
    },
    policy: {
      acceptedAt: new Date(),
      version: "v1",
      text: "Org A cancellation policy, long enough to satisfy validation.",
    },
  });
  return { orderId: String(order._id), ownerId: String(ownerId) };
}

function orgBAdmin() {
  return {
    actor: {
      id: new Types.ObjectId().toString(),
      name: "Org B admin",
      email: "admin@orgb.test",
      role: UserRole.ADMIN,
    },
    orgId: ORG_B,
    request: null,
  };
}

describe("Cross-tenant order access (Pass 5a)", () => {
  it("getOrderById from Org B admin → NotFoundError on Org A's order", async () => {
    const { orderId } = await seedOrgAOrder();
    await expect(getOrderById(orderId, orgBAdmin())).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("archiveOrder from Org B admin → NotFoundError, row untouched", async () => {
    const { orderId } = await seedOrgAOrder();
    await expect(
      archiveOrder(orderId, { reason: "hostile" }, orgBAdmin()),
    ).rejects.toBeInstanceOf(NotFoundError);
    const row = await Order.findById(orderId).lean<{ state: string }>();
    expect(row?.state).toBe(RecordState.ACTIVE);
  });

  it("regeneratePaymentLink from Org B admin → NotFoundError", async () => {
    const { orderId } = await seedOrgAOrder();
    await expect(
      regeneratePaymentLink(orderId, orgBAdmin()),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("setOrderRiskFlag from Org B admin → NotFoundError, risk untouched", async () => {
    const { orderId } = await seedOrgAOrder();
    await expect(
      setOrderRiskFlag(orderId, { flagged: true, note: "evil" }, orgBAdmin()),
    ).rejects.toBeInstanceOf(NotFoundError);
    const row = await Order.findById(orderId).lean<{
      risk: { flagged: boolean };
    }>();
    expect(row?.risk.flagged).toBe(false);
  });

  it("updateOrderCustomer from Org B admin → NotFoundError, customer untouched", async () => {
    const { orderId } = await seedOrgAOrder();
    await expect(
      updateOrderCustomer(
        orderId,
        { name: "Hijacked", email: "x@x.test", phone: "+1" },
        orgBAdmin(),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    const row = await Order.findById(orderId).lean<{
      customer: { name: string };
    }>();
    expect(row?.customer.name).toBe("C");
  });

  it("reconcileOrderPayment from Org B admin → NotFoundError", async () => {
    const { orderId } = await seedOrgAOrder();
    await expect(
      reconcileOrderPayment(orderId, orgBAdmin()),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("deleteOrders from Org B admin → conflict (no deletable matches)", async () => {
    const { orderId } = await seedOrgAOrder();
    // Service throws ConflictError "no deletable orders" because the
    // scoped find returns zero rows for the wrong tenant.
    await expect(deleteOrders([orderId], orgBAdmin())).rejects.toThrow(
      /paid orders cannot be deleted/i,
    );
    // Row still exists.
    const row = await Order.findById(orderId).lean();
    expect(row).toBeTruthy();
  });

  it("listOrders from Org B admin → empty page (no leak of Org A's row)", async () => {
    await seedOrgAOrder();
    const res = await listOrders(
      { state: RecordState.ACTIVE, page: 1, pageSize: 50 },
      orgBAdmin(),
    );
    expect(res.items).toHaveLength(0);
    expect(res.total).toBe(0);
  });

  it("Same-tenant admin CAN read their own order (sanity)", async () => {
    const { orderId } = await seedOrgAOrder();
    const orgAAdmin = {
      actor: {
        id: new Types.ObjectId().toString(),
        name: "Org A admin",
        email: "admin@orga.test",
        role: UserRole.ADMIN,
      },
      orgId: ORG_A,
      request: null,
    };
    const out = await getOrderById(orderId, orgAAdmin);
    expect(out.orderNumber).toBe("ORGA-XCT-1");
  });
});
