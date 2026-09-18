import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";

import { OrderStatus, UserRole } from "@/lib/constants/enums";
import { POST as deleteRoute } from "@/app/api/orders/delete/route";
import { Order } from "@/server/db/models";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { buildRequest, jsonBody } from "@/tests/utils/api";
import { mockNextHeaders } from "@/tests/utils/next-headers";
import { createSettings } from "@/tests/factories/settings.factory";
import { ensureMongo } from "@/tests/utils/db";
import { seedTestOrganization } from "@/tests/utils/organization";
import { validCreateOrderInput } from "@/tests/fixtures/order-input.fixture";

/**
 * Bulk delete is a hard delete, so it must reach only the caller's own
 * organization. It used to look orders up by id alone: an admin who knew
 * another organization's order id could delete it.
 */

const { createOrder, deleteOrders } = await import("@/server/services/order.service");

const admin = actorFor(UserRole.ADMIN);
const staff = actorFor(UserRole.STAFF);
const ctx = { actor: admin, request: null };

let headersMock: Awaited<ReturnType<typeof mockNextHeaders>>;
let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  await seedTestOrganization();
  headersMock = await mockNextHeaders();
  sessionMock = await mockSession(admin);
});
afterEach(async () => {
  await headersMock.restore();
  sessionMock?.restore();
  sessionMock = null;
});

async function makeOrder() {
  const { order } = await createOrder(validCreateOrderInput(), ctx);
  return order;
}

/** An order that belongs to a different organization. */
async function foreignOrder() {
  const order = await makeOrder();
  await Order.updateOne(
    { _id: order.id },
    { $set: { organizationId: new Types.ObjectId() } },
  );
  return order;
}

const exists = async (id: string) => (await Order.exists({ _id: id })) !== null;

describe("deleteOrders stays inside the caller's organization", () => {
  it("deletes an order in the caller's own organization", async () => {
    const order = await makeOrder();
    const result = await deleteOrders([order.id], ctx);
    expect(result).toEqual({ deleted: 1, blockedPaidIds: [] });
    expect(await exists(order.id)).toBe(false);
  });

  it("refuses to delete another organization's order", async () => {
    const theirs = await foreignOrder();
    // Before: this deleted it.
    await expect(deleteOrders([theirs.id], ctx)).rejects.toThrow(/not found/i);
    expect(await exists(theirs.id)).toBe(true);
  });

  it("refuses the whole request when any id is another organization's", async () => {
    const mine = await makeOrder();
    const theirs = await foreignOrder();
    await expect(deleteOrders([mine.id, theirs.id], ctx)).rejects.toThrow(
      /1 of the 2 selected orders was not found\. Nothing was deleted/,
    );
    // Nothing at all was deleted — not even the caller's own order.
    expect(await exists(mine.id)).toBe(true);
    expect(await exists(theirs.id)).toBe(true);
  });

  it("answers another organization's id exactly like one that does not exist", async () => {
    const theirs = await foreignOrder();
    const missing = new Types.ObjectId().toString();
    const a = await deleteOrders([theirs.id], ctx).catch((e: Error) => e);
    const b = await deleteOrders([missing], ctx).catch((e: Error) => e);
    // No way to tell from the response that the other tenant's order is real.
    expect((a as Error).message).toBe((b as Error).message);
    expect((a as { statusCode?: number }).statusCode).toBe(404);
  });

  it("still keeps paid orders, as before", async () => {
    const paid = await makeOrder();
    const open = await makeOrder();
    await Order.updateOne({ _id: paid.id }, { $set: { status: OrderStatus.PAID } });

    const result = await deleteOrders([paid.id, open.id], ctx);
    expect(result).toEqual({ deleted: 1, blockedPaidIds: [paid.id] });
    expect(await exists(paid.id)).toBe(true);
    await expect(deleteOrders([paid.id], ctx)).rejects.toThrow(/Paid orders cannot be deleted/);
  });
});

describe("POST /api/orders/delete", () => {
  const post = (ids: string[]) =>
    deleteRoute(buildRequest("/api/orders/delete", { method: "POST", body: { ids } }));

  it("rejects another organization's id with 404 and deletes nothing", async () => {
    const theirs = await foreignOrder();
    const { status, body } = await jsonBody(await post([theirs.id]));
    expect(status).toBe(404);
    expect((body as { error: { code: string } }).error.code).toBe("NOT_FOUND");
    expect(await exists(theirs.id)).toBe(true);
  });

  it("deletes the caller's own order", async () => {
    const mine = await makeOrder();
    const { status, body } = await jsonBody(await post([mine.id]));
    expect(status).toBe(200);
    expect((body as { data: { deleted: number } }).data.deleted).toBe(1);
    expect(await exists(mine.id)).toBe(false);
  });

  it("keeps the permission rule: STAFF cannot delete, even their own order", async () => {
    const order = await makeOrder();
    sessionMock?.restore();
    sessionMock = await mockSession(staff);
    const { status } = await jsonBody(await post([order.id]));
    expect(status).toBe(403);
    expect(await exists(order.id)).toBe(true);
  });
});
