import { Types } from "mongoose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  Currency,
  OrderStatus,
  RecordState,
  UserRole,
} from "@/lib/constants/enums";
import { QuotaExceededError } from "@/lib/errors";
import { Order } from "@/server/db/models";
import {
  assertCanCreateOrder,
  countActiveOrders,
  getCurrentPlan,
  getOrderQuotaSnapshot,
  PLAN_LIMITS,
} from "@/server/services/billing.service";
import { ensureMongo, resetDatabase } from "@/tests/utils/db";

/**
 * Billing / quota enforcement (v1).
 *
 * Invariants asserted:
 *   1. Counter excludes terminal statuses (PAID / FAILED / EXPIRED).
 *   2. Counter is per-tenant, Tenant B's orders don't move Tenant A.
 *   3. Hard gate throws QuotaExceededError at limit; passes under.
 *   4. Error payload carries plan + limit + current for the UI.
 *   5. Legacy callers (orgId === null) are not metered.
 *   6. Today's plan is hardcoded Starter (catches accidental rewires).
 */

const STARTER_LIMIT = PLAN_LIMITS.starter.activeOrderLimit;

beforeEach(async () => {
  await ensureMongo();
  await resetDatabase();
});
afterEach(async () => {
  await resetDatabase();
});

function orderDoc(orgId: string, status: string): Record<string, unknown> {
  const id = new Types.ObjectId();
  return {
    _id: id,
    orgId: new Types.ObjectId(orgId),
    orderNumber: `Q-${id.toString().slice(-6)}`,
    status,
    state: RecordState.ACTIVE,
    customer: {
      name: "Quota Test",
      email: `q-${id.toString().slice(-6)}@test.local`,
      phone: "+1-555-0000",
    },
    lineItems: [
      {
        itemTypeKey: "service",
        name: "Consulting hour",
        description: null,
        quantity: 1,
        unitPrice: 100,
        total: 100,
        attributes: {},
      },
    ],
    pricing: { amount: 100, currency: Currency.USD },
    payment: { status: "PAYMENT_PENDING", processedWebhookEventIds: [] },
    createdBy: {
      userId: new Types.ObjectId(),
      name: "Owner",
      email: "owner@test.local",
    },
    policy: { acceptedAt: new Date(), version: "v1", text: "" },
    risk: { flagged: false },
    consent: { status: "NOT_REQUESTED" },
  };
}

async function seedOrder(
  orgId: string,
  status: string = OrderStatus.NOT_INITIATED,
): Promise<void> {
  await Order.create(orderDoc(orgId, status));
}

// Bulk insert via insertMany so seeding 30+ rows doesn't turn into 30+
// round-trips against the shared in-memory mongod (otherwise this file
// dominates parallel test runs and starves other order tests).
async function seedManyActive(orgId: string, n: number): Promise<void> {
  if (n <= 0) return;
  const docs = Array.from({ length: n }, () =>
    orderDoc(orgId, OrderStatus.NOT_INITIATED),
  );
  await Order.insertMany(docs);
}

describe("billing.service", () => {
  it("getCurrentPlan returns Starter for every org (v1 hardcode)", async () => {
    const plan = await getCurrentPlan(new Types.ObjectId().toString());
    expect(plan.key).toBe("starter");
    expect(plan.activeOrderLimit).toBe(STARTER_LIMIT);
  });

  it("countActiveOrders returns 0 for a fresh tenant", async () => {
    const orgId = new Types.ObjectId().toString();
    expect(await countActiveOrders(orgId)).toBe(0);
  });

  it("counts NOT_INITIATED + LINK_GENERATED + PAYMENT_PENDING; excludes terminal", async () => {
    const orgId = new Types.ObjectId().toString();
    await seedOrder(orgId, OrderStatus.NOT_INITIATED);
    await seedOrder(orgId, OrderStatus.LINK_GENERATED);
    await seedOrder(orgId, OrderStatus.PAYMENT_PENDING);
    await seedOrder(orgId, OrderStatus.PAID);
    await seedOrder(orgId, OrderStatus.FAILED);
    await seedOrder(orgId, OrderStatus.EXPIRED);
    expect(await countActiveOrders(orgId)).toBe(3);
  });

  it("counts are per-tenant, Tenant B's orders don't move Tenant A", async () => {
    const a = new Types.ObjectId().toString();
    const b = new Types.ObjectId().toString();
    await seedManyActive(a, 5);
    await seedManyActive(b, 7);
    expect(await countActiveOrders(a)).toBe(5);
    expect(await countActiveOrders(b)).toBe(7);
  });

  it("getOrderQuotaSnapshot reports plan + current + remaining + atLimit", async () => {
    const orgId = new Types.ObjectId().toString();
    await seedManyActive(orgId, 2);
    const snap = await getOrderQuotaSnapshot(orgId);
    expect(snap.plan.key).toBe("starter");
    expect(snap.current).toBe(2);
    expect(snap.limit).toBe(STARTER_LIMIT);
    expect(snap.remaining).toBe(STARTER_LIMIT - 2);
    expect(snap.atLimit).toBe(false);
  });

  it("assertCanCreateOrder is a no-op under the cap", async () => {
    const orgId = new Types.ObjectId().toString();
    await seedManyActive(orgId, STARTER_LIMIT - 1);
    await expect(assertCanCreateOrder(orgId)).resolves.toBeUndefined();
  });

  it("assertCanCreateOrder throws QuotaExceededError at the cap", async () => {
    const orgId = new Types.ObjectId().toString();
    await seedManyActive(orgId, STARTER_LIMIT);
    let caught: unknown = null;
    try {
      await assertCanCreateOrder(orgId);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(QuotaExceededError);
    const e = caught as QuotaExceededError;
    expect(e.statusCode).toBe(402);
    expect(e.code).toBe("QUOTA_EXCEEDED");
    expect(e.details).toEqual({
      plan: "starter",
      resource: "active_orders",
      limit: STARTER_LIMIT,
      current: STARTER_LIMIT,
    });
  });

  it("assertCanCreateOrder skips metering when orgId is null (legacy)", async () => {
    // Seeding orders for a real org should not affect a null-org caller.
    const orgId = new Types.ObjectId().toString();
    await seedManyActive(orgId, STARTER_LIMIT);
    await expect(assertCanCreateOrder(null)).resolves.toBeUndefined();
  });
});
