import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";

import {
  PaymentGatewayKey,
  RecordState,
  UserRole,
} from "@/lib/constants/enums";
import { Order, Organization, OrganizationMember } from "@/server/db/models";
import {
  createOrder,
  getOrderById,
  listOrders,
} from "@/server/services/order.service";
import { orgCookieName } from "@/server/auth/org-cookie";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { createSettings } from "@/tests/factories/settings.factory";
import { setNextHeaders } from "@/tests/utils/next-headers";
import { ensureMongo } from "@/tests/utils/db";
import { validCreateOrderInput } from "@/tests/fixtures/order-input.fixture";

/**
 * Cross-organization data isolation, exercised through the real service API.
 *
 * The scoping primitive has its own unit tests; this file is the behavioural
 * proof that the primitive is actually WIRED IN. A leak here is the failure
 * mode the whole migration exists to prevent — one brand reading another
 * brand's orders — and it is exactly the kind of thing that passes a unit
 * test while the service quietly queries unscoped.
 *
 * The asymmetry under test:
 *   - the DEFAULT organization sees its own orders AND pre-migration orders
 *     that were never attributed;
 *   - a NON-DEFAULT organization sees ONLY its own.
 */

let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;

const actor = actorFor(UserRole.ADMIN);

async function makeOrg(slug: string, isDefault: boolean) {
  const doc = await Organization.create({
    slug,
    name: slug,
    brandName: `${slug} brand`,
    isDefault,
    payments: { provider: PaymentGatewayKey.STRIPE },
  });
  const id = doc._id as Types.ObjectId;
  await OrganizationMember.create({
    organizationId: id,
    userId: new Types.ObjectId(actor.id),
    role: UserRole.ADMIN,
    status: RecordState.ACTIVE,
  });
  return id;
}

/** Put the request "inside" an organization, the way the cookie does. */
function actingAs(orgId: Types.ObjectId | null) {
  setNextHeaders(
    orgId ? { cookies: { [orgCookieName()]: String(orgId) } } : {},
  );
}

async function newOrder(orderNumberHint: string) {
  const { order } = await createOrder(
    validCreateOrderInput({
      customer: {
        name: orderNumberHint,
        email: "ada@payops.test",
        phone: "+15555550100",
      },
    }),
    { actor },
  );
  return order;
}

let defaultOrg: Types.ObjectId;
let otherOrg: Types.ObjectId;

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  sessionMock = await mockSession(actor);
  defaultOrg = await makeOrg("rentalconfirmation", true);
  otherOrg = await makeOrg("tripreservations", false);
});

afterEach(() => {
  if (sessionMock) {
    sessionMock.restore();
    sessionMock = null;
  }
});

describe("writes are stamped with the acting organization", () => {
  it("stamps the selected organization on a new order", async () => {
    actingAs(otherOrg);
    const order = await newOrder("trip");
    const doc = await Order.findById(order.id).lean<{
      organizationId?: Types.ObjectId | null;
    } | null>();
    expect(String(doc!.organizationId)).toBe(String(otherOrg));
  });

  it("stamps null when no organization is selected", async () => {
    // Unmigrated / no selection: writes look exactly like pre-migration rows.
    actingAs(null);
    const order = await newOrder("legacy");
    const doc = await Order.findById(order.id).lean<{
      organizationId?: Types.ObjectId | null;
    } | null>();
    expect(doc!.organizationId ?? null).toBeNull();
  });
});

describe("listOrders is scoped", () => {
  it("does not show one organization's orders to another", async () => {
    actingAs(otherOrg);
    const mine = await newOrder("trip-order");

    actingAs(defaultOrg);
    const seen = await listOrders(
      { page: 1, pageSize: 50 } as never,
      { actor },
    );
    expect(seen.items.map((o) => o.id)).not.toContain(mine.id);
  });

  it("gives the default organization its own orders AND unattributed history", async () => {
    // A pre-migration order: written before organizations existed.
    actingAs(null);
    const legacy = await newOrder("legacy-order");

    actingAs(defaultOrg);
    const own = await newOrder("rc-order");

    const seen = await listOrders(
      { page: 1, pageSize: 50 } as never,
      { actor },
    );
    const ids = seen.items.map((o) => o.id);
    expect(ids).toContain(own.id);
    expect(ids).toContain(legacy.id);
  });

  it("does NOT give unattributed history to a non-default organization", async () => {
    // The leak that would matter most: a brand-new tenant inheriting the
    // incumbent's entire order history.
    actingAs(null);
    const legacy = await newOrder("legacy-order");

    actingAs(otherOrg);
    const seen = await listOrders(
      { page: 1, pageSize: 50 } as never,
      { actor },
    );
    expect(seen.items.map((o) => o.id)).not.toContain(legacy.id);
    expect(seen.total).toBe(0);
  });

  it("keeps the search filter working alongside the scope", async () => {
    // listOrders owns the top-level `$or` for search; the scope composes
    // under `$and`. If either clobbered the other this returns the wrong set.
    actingAs(defaultOrg);
    const match = await newOrder("findme");
    await newOrder("someone-else");

    const seen = await listOrders(
      { page: 1, pageSize: 50, q: "findme" } as never,
      { actor },
    );
    expect(seen.items.map((o) => o.id)).toEqual([match.id]);
  });
});

describe("getOrderById is scoped", () => {
  it("returns the order to its own organization", async () => {
    actingAs(otherOrg);
    const order = await newOrder("trip");
    await expect(getOrderById(order.id, { actor })).resolves.toMatchObject({
      id: order.id,
    });
  });

  it("hides another organization's order as NOT FOUND, not FORBIDDEN", async () => {
    // Forbidden would confirm the id exists, letting one tenant enumerate
    // another's order ids from status codes alone.
    actingAs(otherOrg);
    const theirs = await newOrder("trip");

    actingAs(defaultOrg);
    await expect(getOrderById(theirs.id, { actor })).rejects.toThrow(
      /not found/i,
    );
  });

  it("lets the default organization open unattributed history", async () => {
    actingAs(null);
    const legacy = await newOrder("legacy");

    actingAs(defaultOrg);
    await expect(getOrderById(legacy.id, { actor })).resolves.toMatchObject({
      id: legacy.id,
    });
  });

  it("hides unattributed history from a non-default organization", async () => {
    actingAs(null);
    const legacy = await newOrder("legacy");

    actingAs(otherOrg);
    await expect(getOrderById(legacy.id, { actor })).rejects.toThrow(
      /not found/i,
    );
  });
});
