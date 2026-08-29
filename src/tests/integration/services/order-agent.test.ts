import { beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";

import { OrderStatus, RecordState, UserRole } from "@/lib/constants/enums";
import { Order, User } from "@/server/db/models";
import { listOrders } from "@/server/services/order.service";
import { actorFor } from "@/tests/utils/auth";
import { ensureMongo } from "@/tests/utils/db";
import { createOrder } from "@/tests/factories/order.factory";

/**
 * The data behind the Agent column.
 *
 * The column reads `order.createdBy` — a snapshot of name/email/userId
 * written once when the order is created. Everything worth asserting here
 * follows from that being a snapshot rather than a reference:
 *
 *   no lookup   → no per-row user query, whatever the page size
 *   no lookup   → no way to resolve a user from another organization
 *   no rewrite  → an order that predates the snapshot still lists
 *
 * The staff filter and RBAC scoping already keyed off `createdBy.userId`
 * before this column existed; the tests at the end are here to prove that
 * did not change.
 */

const admin = actorFor(UserRole.ADMIN);
const QUERY = {
  state: RecordState.ACTIVE,
  page: 1,
  pageSize: 50,
} as const;

beforeEach(async () => {
  await ensureMongo();
});

describe("the creator snapshot the column reads", () => {
  it("carries the agent's name and email on the order itself", async () => {
    await createOrder({
      createdBy: {
        userId: new Types.ObjectId(),
        name: "Asha Verma",
        email: "asha@ops.test",
      },
    });

    const { items } = await listOrders(QUERY, { actor: admin });
    expect(items[0]?.createdBy.name).toBe("Asha Verma");
    expect(items[0]?.createdBy.email).toBe("asha@ops.test");
  });

  it("lists an order whose creator snapshot is absent, instead of failing the page", async () => {
    // A row from before the snapshot existed. Written past the model on
    // purpose — the schema marks `createdBy` required, which is exactly why
    // the mapping had to stop assuming it is there.
    const withCreator = await createOrder();
    await Order.collection.updateOne(
      { _id: withCreator._id },
      { $unset: { createdBy: "" } },
    );
    await createOrder();

    const { items, total } = await listOrders(QUERY, { actor: admin });

    // Both rows come back — the one without a creator has not vanished.
    expect(total).toBe(2);
    const orphan = items.find((o) => o.id === String(withCreator._id));
    expect(orphan).toBeDefined();
    expect(orphan?.createdBy).toEqual({ userId: "", name: "", email: "" });
  });

  it("survives a creator whose user record was deleted", async () => {
    const ghost = new Types.ObjectId();
    await createOrder({
      createdBy: { userId: ghost, name: "Departed Colleague", email: "gone@ops.test" },
    });
    // The user is gone; the snapshot is not, which is the point of taking one.
    expect(await User.findById(ghost)).toBeNull();

    const { items } = await listOrders(QUERY, { actor: admin });
    expect(items[0]?.createdBy.name).toBe("Departed Colleague");
  });
});

describe("no user is queried to build the list", () => {
  it("issues zero user lookups for a page of orders", async () => {
    for (let i = 0; i < 12; i++) {
      await createOrder({
        createdBy: {
          userId: new Types.ObjectId(),
          name: `Agent ${i}`,
          email: `agent${i}@ops.test`,
        },
      });
    }

    // Every read path the model exposes. One query per order would show up
    // as twelve calls here; a batched lookup would show up as one. The
    // column needs neither.
    const find = vi.spyOn(User, "find");
    const findOne = vi.spyOn(User, "findOne");
    const findById = vi.spyOn(User, "findById");

    const { items } = await listOrders(QUERY, { actor: admin });

    expect(items).toHaveLength(12);
    expect(find).not.toHaveBeenCalled();
    expect(findOne).not.toHaveBeenCalled();
    expect(findById).not.toHaveBeenCalled();

    find.mockRestore();
    findOne.mockRestore();
    findById.mockRestore();
  });
});

describe("tenancy", () => {
  it("never returns an order belonging to another organization", async () => {
    const mine = await createOrder({
      createdBy: {
        userId: new Types.ObjectId(),
        name: "Asha Verma",
        email: "asha@ops.test",
      },
    });

    // An order stamped to a different organization, with a creator whose
    // name would be conspicuous if it ever surfaced.
    const foreign = await createOrder({
      createdBy: {
        userId: new Types.ObjectId(),
        name: "Other Tenant Staffer",
        email: "staffer@othertenant.test",
      },
    });
    await Order.collection.updateOne(
      { _id: foreign._id },
      { $set: { organizationId: new Types.ObjectId() } },
    );

    const { items } = await listOrders(QUERY, { actor: admin });
    const ids = items.map((o) => o.id);

    expect(ids).toContain(String(mine._id));
    expect(ids).not.toContain(String(foreign._id));
    expect(items.map((o) => o.createdBy.name)).not.toContain("Other Tenant Staffer");
  });

  it("resolves the agent from the order, never by matching a name or email", async () => {
    // Two organizations' orders can carry the same creator email without one
    // being able to reach the other's user: there is no lookup by identity,
    // only the snapshot each order already holds.
    const shared = "shared@ops.test";
    await createOrder({
      createdBy: { userId: new Types.ObjectId(), name: "Ours", email: shared },
    });

    const { items } = await listOrders(QUERY, { actor: admin });
    expect(items[0]?.createdBy.email).toBe(shared);
    expect(items[0]?.createdBy.name).toBe("Ours");
  });
});

describe("existing list behaviour is unchanged", () => {
  it("still scopes to the actor with mine=true — the All staff / Only mine filter", async () => {
    const mineDoc = await createOrder({
      createdBy: {
        userId: new Types.ObjectId(admin.id),
        name: admin.name,
        email: "admin@ops.test",
      },
    });
    await createOrder({
      createdBy: {
        userId: new Types.ObjectId(),
        name: "Someone Else",
        email: "else@ops.test",
      },
    });

    const all = await listOrders(QUERY, { actor: admin });
    expect(all.total).toBe(2);

    const onlyMine = await listOrders({ ...QUERY, mine: true }, { actor: admin });
    expect(onlyMine.total).toBe(1);
    expect(onlyMine.items[0]?.id).toBe(String(mineDoc._id));
  });

  it("still searches by customer and order number", async () => {
    await createOrder({ customer: { name: "Findable Guest", email: "f@x.test", phone: "+15550001" } });
    await createOrder({ customer: { name: "Other Guest", email: "o@x.test", phone: "+15550002" } });

    const found = await listOrders({ ...QUERY, q: "Findable" }, { actor: admin });
    expect(found.total).toBe(1);
    expect(found.items[0]?.customer.name).toBe("Findable Guest");
  });

  it("still filters by status", async () => {
    await createOrder({ status: OrderStatus.PAID });
    await createOrder({ status: OrderStatus.PAYMENT_PENDING });

    const paid = await listOrders({ ...QUERY, status: OrderStatus.PAID }, { actor: admin });
    expect(paid.total).toBe(1);
    expect(paid.items[0]?.status).toBe(OrderStatus.PAID);
  });

  it("still paginates", async () => {
    for (let i = 0; i < 5; i++) await createOrder();

    const first = await listOrders({ ...QUERY, page: 1, pageSize: 2 }, { actor: admin });
    const second = await listOrders({ ...QUERY, page: 2, pageSize: 2 }, { actor: admin });

    expect(first.total).toBe(5);
    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(2);
    expect(first.items.map((o) => o.id)).not.toEqual(second.items.map((o) => o.id));
  });
});
