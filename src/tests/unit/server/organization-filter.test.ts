import { describe, expect, it } from "vitest";
import { Types } from "mongoose";

import {
  belongsToScope,
  organizationScopeClause,
  organizationStamp,
  withOrganizationScope,
} from "@/server/db/organization-filter";

/**
 * The tenancy filter primitive.
 *
 * Two asymmetric rules are the heart of the migration and both are easy to
 * get backwards:
 *
 *   - the DEFAULT organization must see unattributed history, or every
 *     pre-migration record disappears from the product the day the column
 *     ships;
 *   - every OTHER organization must NOT see it, or a new brand silently
 *     inherits another brand's orders.
 */

const ORG_A = new Types.ObjectId().toString();
const ORG_B = new Types.ObjectId().toString();

const asDefault = { organizationId: ORG_A, isDefault: true };
const asTenant = { organizationId: ORG_B, isDefault: false };
const unmigrated = { organizationId: null, isDefault: false };

describe("organizationScopeClause", () => {
  it("lets the default organization see its own rows AND unattributed history", () => {
    const clause = organizationScopeClause(asDefault) as {
      $or: Record<string, unknown>[];
    };
    expect(clause.$or).toEqual([
      { organizationId: new Types.ObjectId(ORG_A) },
      { organizationId: null },
      { organizationId: { $exists: false } },
    ]);
  });

  it("restricts a non-default organization to its own rows only", () => {
    expect(organizationScopeClause(asTenant)).toEqual({
      organizationId: new Types.ObjectId(ORG_B),
    });
  });

  it("does not scope at all on an unmigrated deployment", () => {
    expect(organizationScopeClause(unmigrated)).toBeNull();
  });

  it("matches nothing rather than widening on a malformed id", () => {
    // A bad id must never degrade to "no scope" — that would turn a bug
    // into a cross-tenant read.
    expect(
      organizationScopeClause({ organizationId: "garbage", isDefault: false }),
    ).toEqual({ _id: { $in: [] } });
  });
});

describe("withOrganizationScope composition", () => {
  it("preserves an existing top-level $or instead of clobbering it", () => {
    // listOrders builds a search `$or`. Assigning a second `$or` would
    // silently drop one of them depending on key order.
    const search = {
      state: "ACTIVE",
      $or: [{ orderNumber: /abc/ }, { "customer.email": /abc/ }],
    };
    const scoped = withOrganizationScope(search, asTenant);

    expect(scoped.$or).toBe(search.$or);
    expect(scoped.state).toBe("ACTIVE");
    expect(scoped.$and).toEqual([
      { organizationId: new Types.ObjectId(ORG_B) },
    ]);
  });

  it("appends to an existing $and rather than replacing it", () => {
    const filter = { $and: [{ a: 1 }] };
    const scoped = withOrganizationScope(filter, asTenant);
    expect(scoped.$and).toHaveLength(2);
    expect(scoped.$and![0]).toEqual({ a: 1 });
  });

  it("does not mutate the caller's filter", () => {
    const filter: Record<string, unknown> = { state: "ACTIVE" };
    withOrganizationScope(filter, asTenant);
    expect(filter).toEqual({ state: "ACTIVE" });
  });

  it("is a no-op on an unmigrated deployment", () => {
    const filter = { state: "ACTIVE" };
    expect(withOrganizationScope(filter, unmigrated)).toEqual({
      state: "ACTIVE",
    });
  });
});

describe("organizationStamp", () => {
  it("stamps the acting organization on new records", () => {
    expect(String(organizationStamp(asTenant))).toBe(ORG_B);
  });

  it("stamps null on an unmigrated deployment, matching historical rows", () => {
    expect(organizationStamp(unmigrated)).toBeNull();
  });
});

describe("belongsToScope", () => {
  const idA = new Types.ObjectId(ORG_A);
  const idB = new Types.ObjectId(ORG_B);

  it("accepts a document stamped with the acting organization", () => {
    expect(belongsToScope(idB, asTenant)).toBe(true);
  });

  it("rejects another organization's document", () => {
    expect(belongsToScope(idA, asTenant)).toBe(false);
    expect(belongsToScope(idB, asDefault)).toBe(false);
  });

  it("gives unattributed history to the default organization only", () => {
    expect(belongsToScope(null, asDefault)).toBe(true);
    expect(belongsToScope(undefined, asDefault)).toBe(true);
    expect(belongsToScope(null, asTenant)).toBe(false);
    expect(belongsToScope(undefined, asTenant)).toBe(false);
  });

  it("permits everything on an unmigrated deployment", () => {
    expect(belongsToScope(null, unmigrated)).toBe(true);
    expect(belongsToScope(idA, unmigrated)).toBe(true);
  });
});
