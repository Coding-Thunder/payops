import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";

import {
  PaymentGatewayKey,
  RecordState,
  UserRole,
} from "@/lib/constants/enums";
import {
  Order,
  OrderEvidence,
  Organization,
  OrganizationMember,
} from "@/server/db/models";
import { getEvidenceChain } from "@/server/services/evidence.service";
import { listConsentsForOrder } from "@/server/services/consent.service";
import {
  createOrder,
  getOrderById,
  listOrders,
} from "@/server/services/order.service";
import { getAnalyticsSummary } from "@/server/services/analytics.service";
import { listAuditLogs } from "@/server/services/audit.service";
import {
  createCarLink,
  deactivateCarLink,
  getCarLinkById,
  listCarLinks,
} from "@/server/services/car-link.service";
import {
  createDraft,
  listDrafts,
} from "@/server/services/order-draft.service";
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

describe("the dashboard is scoped", () => {
  it("does not count another organization's revenue or orders", async () => {
    // An unscoped $match here is the quiet kind of leak: another brand's
    // revenue simply blends into your totals as a plausible number.
    actingAs(otherOrg);
    await newOrder("trip-1");
    await newOrder("trip-2");

    actingAs(defaultOrg);
    const summary = await getAnalyticsSummary({});
    expect(summary.totals.ordersCreated).toBe(0);

    actingAs(otherOrg);
    const theirs = await getAnalyticsSummary({});
    expect(theirs.totals.ordersCreated).toBe(2);
  });
});

describe("the audit log is scoped", () => {
  it("does not expose another organization's activity", async () => {
    // Audit rows carry operator names, customer emails and order numbers.
    actingAs(otherOrg);
    const theirOrder = await newOrder("trip");

    actingAs(defaultOrg);
    const { items } = await listAuditLogs({ pageSize: 100 });
    expect(items.map((i) => i.entityId)).not.toContain(theirOrder.id);
  });

  it("still records rows for the acting organization", async () => {
    actingAs(otherOrg);
    const mine = await newOrder("trip");
    const { items } = await listAuditLogs({ pageSize: 100 });
    expect(items.map((i) => i.entityId)).toContain(mine.id);
  });
});

describe("car links are SHARED, not scoped", () => {
  async function newCarLink(make: string) {
    return createCarLink(
      {
        carMake: make,
        carType: "Camry",
        imageUrl: "https://x.test/a.png",
        notes: null,
      },
      { actor: { id: actor.id, name: actor.name, role: actor.role } },
    );
  }

  // The car library is reference data, like the `providers` rental-brand
  // catalog: "Toyota Camry" and its image belong to no single brand. Both
  // organizations share one library, so an entry added while working in
  // either is available in the other.

  it("shows an entry added by one organization to the other", async () => {
    actingAs(otherOrg);
    const added = await newCarLink("Toyota");

    actingAs(defaultOrg);
    const listed = await listCarLinks({ limit: 50 } as never);
    expect(listed.map((c) => c.id)).toContain(added.id);
  });

  it("lets either organization open any entry", async () => {
    actingAs(otherOrg);
    const added = await newCarLink("Honda");

    actingAs(defaultOrg);
    await expect(getCarLinkById(added.id)).resolves.toMatchObject({
      id: added.id,
    });
  });

  it("lets either organization deactivate an entry", async () => {
    actingAs(otherOrg);
    const added = await newCarLink("Mazda");

    actingAs(defaultOrg);
    await deactivateCarLink(added.id, {
      actor: { id: actor.id, name: actor.name, role: actor.role },
    });
    const after = await getCarLinkById(added.id);
    expect(after.active).toBe(false);
  });
});

describe("evidence is scoped", () => {
  it("inherits the order's organization, not the caller's context", async () => {
    // createOrder writes a genesis evidence row in the same transaction.
    // Most later evidence is written by a webhook with NO organization
    // context, so inheriting from the order is what keeps a tenant's own
    // evidence visible to them instead of falling to the default org.
    actingAs(otherOrg);
    const order = await newOrder("trip");

    const rows = await OrderEvidence.find({
      orderId: new Types.ObjectId(order.id),
    }).lean<{ organizationId?: Types.ObjectId | null }[]>();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(String(row.organizationId)).toBe(String(otherOrg));
    }
  });

  it("refuses another organization's evidence chain as NOT FOUND", async () => {
    // The chain carries customer email, amounts and consent signatures, and
    // it reads the order directly rather than through the scoped
    // getOrderById — so it needs its own check.
    actingAs(otherOrg);
    const theirs = await newOrder("trip");

    actingAs(defaultOrg);
    await expect(
      getEvidenceChain(theirs.id, { actor }),
    ).rejects.toThrow(/not found/i);
  });

  it("serves the chain to the owning organization", async () => {
    actingAs(otherOrg);
    const mine = await newOrder("trip");
    const chain = await getEvidenceChain(mine.id, { actor });
    expect(chain.events.length).toBeGreaterThan(0);
  });
});

describe("consent is scoped for operators but not for customers", () => {
  it("does not list another organization's consent records", async () => {
    actingAs(otherOrg);
    const theirs = await newOrder("trip");

    actingAs(defaultOrg);
    const listed = await listConsentsForOrder(theirs.id, { actor });
    expect(listed).toEqual([]);
  });
});

describe("drafts are scoped", () => {
  it("does not surface the same user's drafts from another organization", async () => {
    // Drafts were already owner-scoped; that is not the same as
    // organization-scoped for a user who belongs to two brands.
    actingAs(otherOrg);
    const theirs = await createDraft({ data: { note: "trip" } }, { actor });

    actingAs(defaultOrg);
    const mine = await listDrafts({ actor });
    expect(mine.map((d) => d.id)).not.toContain(theirs.id);

    actingAs(otherOrg);
    const back = await listDrafts({ actor });
    expect(back.map((d) => d.id)).toContain(theirs.id);
  });
});
