import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";

import { PaymentGatewayKey, RecordState, UserRole } from "@/lib/constants/enums";
import { Organization, OrganizationMember } from "@/server/db/models";
import {
  assertOrganizationAccess,
  getOrganizationRole,
  getSelectedOrganization,
  listMemberOrganizations,
  organizationsExist,
} from "@/server/auth/organization";
import { orgCookieName } from "@/server/auth/org-cookie";
import { GET as listRoute } from "@/app/api/organizations/route";
import { POST as switchRoute } from "@/app/api/organizations/switch/route";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { buildRequest, jsonBody } from "@/tests/utils/api";
import { setNextHeaders } from "@/tests/utils/next-headers";
import { ensureMongo } from "@/tests/utils/db";

/**
 * Organization context resolution — the authorization boundary for
 * multi-tenancy.
 *
 * The property under test throughout: the selected-org cookie is a HINT.
 * The membership row is the authority. A cookie naming an organization the
 * caller is not an active member of must resolve to "no selection", never
 * to that organization, however well-formed it is.
 */

let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;

async function makeOrg(slug: string, isDefault = false) {
  const doc = await Organization.create({
    slug,
    name: slug,
    brandName: `${slug} brand`,
    isDefault,
    payments: { provider: PaymentGatewayKey.STRIPE },
  });
  return doc._id as Types.ObjectId;
}

async function join(
  orgId: Types.ObjectId,
  userId: string,
  role: UserRole = UserRole.ADMIN,
  status: RecordState = RecordState.ACTIVE,
) {
  await OrganizationMember.create({
    organizationId: orgId,
    userId: new Types.ObjectId(userId),
    role,
    status,
  });
}

beforeEach(async () => {
  await ensureMongo();
  setNextHeaders();
});

afterEach(() => {
  if (sessionMock) {
    sessionMock.restore();
    sessionMock = null;
  }
});

describe("organizationsExist — the migration switch", () => {
  it("is false on an unmigrated deployment, keeping the whole layer inert", async () => {
    expect(await organizationsExist()).toBe(false);
  });

  it("is true once an organization is seeded", async () => {
    await makeOrg("rentalconfirmation", true);
    expect(await organizationsExist()).toBe(true);
  });
});

describe("listMemberOrganizations", () => {
  it("returns nothing when unauthenticated", async () => {
    await makeOrg("rentalconfirmation", true);
    sessionMock = await mockSession(null);
    expect(await listMemberOrganizations()).toEqual([]);
  });

  it("returns only organizations the user is a member of", async () => {
    const actor = actorFor(UserRole.STAFF);
    const mine = await makeOrg("rentalconfirmation", true);
    await makeOrg("tripreservations");
    await join(mine, actor.id);
    sessionMock = await mockSession(actor);

    const orgs = await listMemberOrganizations();
    expect(orgs.map((o) => o.slug)).toEqual(["rentalconfirmation"]);
  });

  it("excludes memberships that have been revoked", async () => {
    const actor = actorFor(UserRole.STAFF);
    const org = await makeOrg("rentalconfirmation", true);
    await join(org, actor.id, UserRole.ADMIN, RecordState.DISABLED);
    sessionMock = await mockSession(actor);
    expect(await listMemberOrganizations()).toEqual([]);
  });

  it("excludes organizations that are themselves disabled", async () => {
    const actor = actorFor(UserRole.ADMIN);
    const org = await makeOrg("rentalconfirmation", true);
    await join(org, actor.id);
    await Organization.updateOne(
      { _id: org },
      { $set: { status: RecordState.DISABLED } },
    );
    sessionMock = await mockSession(actor);
    expect(await listMemberOrganizations()).toEqual([]);
  });

  it("GRANTS ADMIN and SUPER_ADMIN access to every ACTIVE organization", async () => {
    // BEHAVIOUR REVERSAL, recorded deliberately.
    //
    // This test previously asserted the opposite: that a global role is not
    // a membership, and that letting SUPER_ADMIN bypass the check would make
    // "no cross-organization access" false for exactly the account most
    // likely to be automated against. That reasoning still holds as a
    // security observation — it was traded away on an explicit product
    // decision, because one operations team works all three brands and
    // hand-inserting a membership per organization made the global roles
    // less useful than their names imply.
    //
    // The trade: an ADMIN or SUPER_ADMIN credential now reaches all three
    // brands, including FlightBizz's live Stripe account.
    //
    // Scoping for every OTHER role is unchanged, and the tests around this
    // one (now using STAFF) are what prove it.
    const actor = actorFor(UserRole.SUPER_ADMIN);
    await makeOrg("rentalconfirmation", true);
    await makeOrg("tripreservations");
    sessionMock = await mockSession(actor);
    const slugs = (await listMemberOrganizations()).map((o) => o.slug).sort();
    expect(slugs).toEqual(["rentalconfirmation", "tripreservations"]);
  });
});

describe("getSelectedOrganization — the cookie is only a hint", () => {
  it("is null when no cookie is set", async () => {
    const actor = actorFor(UserRole.ADMIN);
    const org = await makeOrg("rentalconfirmation", true);
    await join(org, actor.id);
    sessionMock = await mockSession(actor);
    expect(await getSelectedOrganization()).toBeNull();
  });

  it("resolves an organization the user belongs to", async () => {
    const actor = actorFor(UserRole.ADMIN);
    const org = await makeOrg("rentalconfirmation", true);
    await join(org, actor.id);
    sessionMock = await mockSession(actor);
    setNextHeaders({ cookies: { [orgCookieName()]: String(org) } });

    const selected = await getSelectedOrganization();
    expect(selected?.slug).toBe("rentalconfirmation");
  });

  it("REFUSES a forged cookie naming someone else's organization", async () => {
    const actor = actorFor(UserRole.STAFF);
    const mine = await makeOrg("rentalconfirmation", true);
    const theirs = await makeOrg("tripreservations");
    await join(mine, actor.id);
    sessionMock = await mockSession(actor);

    // Hand-crafted cookie pointing at a real, active organization that this
    // user simply is not a member of.
    setNextHeaders({ cookies: { [orgCookieName()]: String(theirs) } });
    expect(await getSelectedOrganization()).toBeNull();
  });

  it("ignores a malformed cookie value", async () => {
    const actor = actorFor(UserRole.ADMIN);
    const org = await makeOrg("rentalconfirmation", true);
    await join(org, actor.id);
    sessionMock = await mockSession(actor);
    setNextHeaders({ cookies: { [orgCookieName()]: "../../etc/passwd" } });
    expect(await getSelectedOrganization()).toBeNull();
  });

  it("stops resolving once the membership is revoked", async () => {
    const actor = actorFor(UserRole.STAFF);
    const org = await makeOrg("rentalconfirmation", true);
    await join(org, actor.id, UserRole.ADMIN, RecordState.DISABLED);
    sessionMock = await mockSession(actor);
    setNextHeaders({ cookies: { [orgCookieName()]: String(org) } });
    expect(await getSelectedOrganization()).toBeNull();
  });
});

describe("assertOrganizationAccess", () => {
  it("returns the organization for a member", async () => {
    const actor = actorFor(UserRole.ADMIN);
    const org = await makeOrg("rentalconfirmation", true);
    await join(org, actor.id);
    sessionMock = await mockSession(actor);
    await expect(assertOrganizationAccess(String(org))).resolves.toMatchObject({
      slug: "rentalconfirmation",
    });
  });

  it("refuses a non-member organization and a non-existent one identically", async () => {
    // Same message either way — otherwise this is an oracle for probing
    // which organization ids exist.
    const actor = actorFor(UserRole.STAFF);
    const mine = await makeOrg("rentalconfirmation", true);
    const theirs = await makeOrg("tripreservations");
    await join(mine, actor.id);
    sessionMock = await mockSession(actor);

    const messages: string[] = [];
    for (const id of [String(theirs), String(new Types.ObjectId()), "nope"]) {
      await assertOrganizationAccess(id).catch((e: Error) =>
        messages.push(e.message),
      );
    }
    expect(messages).toHaveLength(3);
    expect(new Set(messages).size).toBe(1);
  });
});

describe("getOrganizationRole", () => {
  it("reports the per-organization role, which may differ from the global one", async () => {
    const actor = actorFor(UserRole.SUPER_ADMIN);
    const org = await makeOrg("rentalconfirmation", true);
    await join(org, actor.id, UserRole.STAFF);
    sessionMock = await mockSession(actor);
    expect(await getOrganizationRole(String(org))).toBe(UserRole.STAFF);
  });

  it("is null for a non-member", async () => {
    const actor = actorFor(UserRole.ADMIN);
    const org = await makeOrg("rentalconfirmation", true);
    sessionMock = await mockSession(actor);
    expect(await getOrganizationRole(String(org))).toBeNull();
  });
});

describe("POST /api/organizations/switch", () => {
  it("sets the cookie for an organization the caller belongs to", async () => {
    const actor = actorFor(UserRole.ADMIN);
    const org = await makeOrg("rentalconfirmation", true);
    await join(org, actor.id);
    sessionMock = await mockSession(actor);
    const jar = setNextHeaders().cookies;

    const res = await switchRoute(
      buildRequest("/api/organizations/switch", {
        method: "POST",
        body: { organizationId: String(org) },
      }),
    );
    const { status } = await jsonBody(res);
    expect(status).toBe(200);
    expect(jar.get(orgCookieName())).toBe(String(org));
  });

  it("REFUSES another organization and leaves the cookie untouched", async () => {
    const actor = actorFor(UserRole.STAFF);
    const mine = await makeOrg("rentalconfirmation", true);
    const theirs = await makeOrg("tripreservations");
    await join(mine, actor.id);
    sessionMock = await mockSession(actor);
    const jar = setNextHeaders({
      cookies: { [orgCookieName()]: String(mine) },
    }).cookies;

    const res = await switchRoute(
      buildRequest("/api/organizations/switch", {
        method: "POST",
        body: { organizationId: String(theirs) },
      }),
    );
    const { status } = await jsonBody(res);
    expect(status).toBe(403);
    // The previous, legitimate selection survives a refused switch.
    expect(jar.get(orgCookieName())).toBe(String(mine));
  });

  it("rejects a malformed organization id with a validation error", async () => {
    const actor = actorFor(UserRole.ADMIN);
    sessionMock = await mockSession(actor);
    const res = await switchRoute(
      buildRequest("/api/organizations/switch", {
        method: "POST",
        body: { organizationId: "not-an-id" },
      }),
    );
    const { status } = await jsonBody(res);
    expect(status).toBe(422);
  });

  it("requires authentication", async () => {
    sessionMock = await mockSession(null);
    const res = await switchRoute(
      buildRequest("/api/organizations/switch", {
        method: "POST",
        body: { organizationId: String(new Types.ObjectId()) },
      }),
    );
    const { status } = await jsonBody(res);
    expect(status).toBe(401);
  });
});

describe("GET /api/organizations", () => {
  it("lists only the caller's organizations and never other tenants", async () => {
    const actor = actorFor(UserRole.STAFF);
    const mine = await makeOrg("rentalconfirmation", true);
    await makeOrg("tripreservations");
    await join(mine, actor.id);
    sessionMock = await mockSession(actor);
    setNextHeaders({ cookies: { [orgCookieName()]: String(mine) } });

    const res = await listRoute();
    const { status, body } = await jsonBody(res);
    expect(status).toBe(200);
    const data = (body as { data: { organizations: { slug: string }[]; selectedId: string | null } }).data;
    expect(data.organizations.map((o) => o.slug)).toEqual([
      "rentalconfirmation",
    ]);
    expect(data.selectedId).toBe(String(mine));
    expect(JSON.stringify(data)).not.toContain("tripreservations");
  });
});
