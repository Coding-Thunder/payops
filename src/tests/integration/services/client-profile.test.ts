import { Types } from "mongoose";
import { beforeEach, describe, expect, it } from "vitest";

import { AuditAction, AuditEntity, RecordState } from "@/lib/constants/enums";
import { NotFoundError } from "@/lib/errors";
import { AuditLog, Customer, Order } from "@/server/db/models";
import {
  getClientProfile,
  getClientTimeline,
  listClients,
  updateClient,
} from "@/server/services/client-profile.service";
import { ensureMongo, resetDatabase } from "@/tests/utils/db";

/**
 * Client Profile read/aggregation surface. Seeds Customer + Order rows
 * directly so the tests pin the SERVICE logic (per-currency financials,
 * tenant isolation, update+audit, timeline assembly) independent of the
 * order-create pipeline.
 */

beforeEach(async () => {
  await ensureMongo();
  await resetDatabase();
});

let orderSeq = 0;

async function makeCustomer(
  orgId: Types.ObjectId,
  overrides: Partial<{ name: string; email: string; phone: string }> = {},
): Promise<Types.ObjectId> {
  const c = await Customer.create({
    orgId,
    name: overrides.name ?? "Vela Skincare",
    email: overrides.email ?? "priya@vela.test",
    phone: overrides.phone ?? "+1 555 0100",
    tags: [],
  });
  return c._id;
}

async function makeOrder(args: {
  orgId: Types.ObjectId;
  customerId: Types.ObjectId;
  email?: string;
  amount: number;
  currency?: string;
  paid?: boolean;
  status?: string;
  refunded?: number;
  state?: RecordState;
}): Promise<Types.ObjectId> {
  orderSeq += 1;
  const o = await Order.create({
    orgId: args.orgId,
    customerId: args.customerId,
    orderNumber: `T-${String(orderSeq).padStart(5, "0")}`,
    status: args.status ?? (args.paid ? "PAID" : "PAYMENT_PENDING"),
    state: args.state ?? RecordState.ACTIVE,
    customer: {
      name: "Vela Skincare",
      email: args.email ?? "priya@vela.test",
      phone: "+1 555 0100",
    },
    pricing: { amount: args.amount, currency: args.currency ?? "USD" },
    payment: {
      status: args.status ?? (args.paid ? "PAID" : "PAYMENT_PENDING"),
      paidAt: args.paid ? new Date() : null,
    },
    createdBy: {
      userId: new Types.ObjectId(),
      name: "agent",
      email: "agent@tracetxn.test",
    },
    refundedAmount: args.refunded ?? 0,
  });
  return o._id;
}

describe("getClientProfile", () => {
  it("computes lifetime aggregates from linked orders", async () => {
    const orgId = new Types.ObjectId();
    const customerId = await makeCustomer(orgId);
    await makeOrder({ orgId, customerId, amount: 100, paid: true });
    await makeOrder({ orgId, customerId, amount: 200, paid: true, refunded: 50 });
    await makeOrder({
      orgId,
      customerId,
      amount: 40,
      paid: false,
      status: "PAYMENT_PENDING",
    });

    const profile = await getClientProfile(String(orgId), String(customerId));
    expect(profile.totals.totalOrders).toBe(3);
    expect(profile.totals.paidOrders).toBe(2);
    expect(profile.totals.revenue).toBe(300); // 100 + 200 paid
    expect(profile.totals.refunded).toBe(50);
    expect(profile.totals.outstanding).toBe(40); // the pending order
    expect(profile.totals.averageOrderValue).toBe(150); // 300 / 2 paid
    expect(profile.totals.currency).toBe("USD");
    expect(profile.totals.multiCurrency).toBe(false);
    expect(profile.orders).toHaveLength(3);
  });

  it("groups financials by currency (never sums across currencies)", async () => {
    const orgId = new Types.ObjectId();
    const customerId = await makeCustomer(orgId);
    // 3 USD paid (600) vs 1 EUR paid (10) → USD is primary, no cross-sum.
    await makeOrder({ orgId, customerId, amount: 200, currency: "USD", paid: true });
    await makeOrder({ orgId, customerId, amount: 200, currency: "USD", paid: true });
    await makeOrder({ orgId, customerId, amount: 200, currency: "USD", paid: true });
    await makeOrder({ orgId, customerId, amount: 10, currency: "EUR", paid: true });

    const profile = await getClientProfile(String(orgId), String(customerId));
    expect(profile.totals.multiCurrency).toBe(true);
    expect(profile.totals.currency).toBe("USD");
    expect(profile.totals.revenue).toBe(600); // USD only — NOT 610
    expect(profile.totals.paidOrders).toBe(4);
  });

  it("excludes archived orders from the aggregates", async () => {
    const orgId = new Types.ObjectId();
    const customerId = await makeCustomer(orgId);
    await makeOrder({ orgId, customerId, amount: 100, paid: true });
    await makeOrder({
      orgId,
      customerId,
      amount: 999,
      paid: true,
      state: RecordState.ARCHIVED,
    });

    const profile = await getClientProfile(String(orgId), String(customerId));
    expect(profile.totals.totalOrders).toBe(1);
    expect(profile.totals.revenue).toBe(100);
  });

  it("is tenant-isolated (a different org can't read the profile)", async () => {
    const orgA = new Types.ObjectId();
    const orgB = new Types.ObjectId();
    const customerId = await makeCustomer(orgA);
    await expect(
      getClientProfile(String(orgB), String(customerId)),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("listClients", () => {
  it("lists only the tenant's clients and supports search", async () => {
    const orgA = new Types.ObjectId();
    const orgB = new Types.ObjectId();
    await makeCustomer(orgA, { name: "Vela Skincare", email: "a@vela.test" });
    await makeCustomer(orgA, { name: "Northwind", email: "b@northwind.test" });
    await makeCustomer(orgB, { name: "Other Tenant", email: "x@other.test" });

    const all = await listClients(String(orgA));
    expect(all.total).toBe(2); // orgB's client excluded

    const search = await listClients(String(orgA), { search: "vela" });
    expect(search.total).toBe(1);
    expect(search.items[0].name).toBe("Vela Skincare");
  });
});

describe("updateClient", () => {
  it("updates identity fields and writes a CUSTOMER_UPDATED audit row", async () => {
    const orgId = new Types.ObjectId();
    const customerId = await makeCustomer(orgId);
    const actor = { id: new Types.ObjectId().toString(), name: "Admin", role: "ADMIN" };

    const updated = await updateClient(
      String(orgId),
      String(customerId),
      { company: "Vela, Inc.", tags: ["priority", "priority", " retainer "] },
      { actor, request: null },
    );
    expect(updated.company).toBe("Vela, Inc.");
    expect(updated.tags).toEqual(["priority", "retainer"]); // deduped + trimmed

    const audit = await AuditLog.findOne({
      action: AuditAction.CUSTOMER_UPDATED,
      entityType: AuditEntity.CUSTOMER,
      entityId: String(customerId),
    }).lean();
    expect(audit).not.toBeNull();
  });

  it("refuses to update a client in another tenant", async () => {
    const orgA = new Types.ObjectId();
    const orgB = new Types.ObjectId();
    const customerId = await makeCustomer(orgA);
    const actor = { id: new Types.ObjectId().toString(), name: "Admin", role: "ADMIN" };
    await expect(
      updateClient(String(orgB), String(customerId), { company: "x" }, {
        actor,
        request: null,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("getClientTimeline", () => {
  it("assembles client-created + order events, newest first", async () => {
    const orgId = new Types.ObjectId();
    const customerId = await makeCustomer(orgId);
    await makeOrder({ orgId, customerId, amount: 100, paid: true });

    const events = await getClientTimeline(String(orgId), String(customerId));
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("client.created");
    expect(kinds).toContain("order.created");
    expect(kinds).toContain("order.paid");
    // Newest-first ordering.
    for (let i = 1; i < events.length; i += 1) {
      expect(events[i - 1].at >= events[i].at).toBe(true);
    }
  });
});
