import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";

import {
  PaymentGatewayKey,
  RecordState,
  UserRole,
} from "@/lib/constants/enums";
import { Organization, OrganizationMember, User } from "@/server/db/models";
import {
  listMemberOrganizations,
  assertOrganizationAccess,
} from "@/server/auth/organization";
import { createUser, updateUser } from "@/server/services/user.service";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { setNextHeaders } from "@/tests/utils/next-headers";
import { ensureMongo } from "@/tests/utils/db";

/**
 * The organization ACCESS model.
 *
 * Two rules, and they pull in opposite directions, which is why both need
 * pinning:
 *
 *   1. ADMIN and SUPER_ADMIN reach every ACTIVE organization WITHOUT any
 *      membership row. This deliberately reverses the codebase's original
 *      "membership required for every role" rule (see the header of
 *      src/server/auth/organization.ts) on an explicit product decision.
 *
 *   2. Every other role reaches ONLY organizations it holds an ACTIVE
 *      membership for. Revocation must bite immediately.
 *
 * Enforcement lives in `listMemberOrganizations`, which is the single
 * chokepoint — `getSelectedOrganization`, `assertOrganizationAccess` and
 * `getRequestOrganizationScope` all resolve through it. Testing it here
 * therefore tests the whole authorization surface, not one caller.
 */

let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;

async function makeOrg(slug: string, isDefault = false, status = RecordState.ACTIVE) {
  const doc = await Organization.create({
    slug,
    name: slug,
    brandName: `${slug} brand`,
    isDefault,
    status,
    payments: { provider: PaymentGatewayKey.STRIPE },
  });
  return doc._id as Types.ObjectId;
}

/** A real User row, because the access rules key off its stored role. */
async function makeUser(role: UserRole, email: string) {
  const doc = await User.create({
    name: `${role} user`,
    email,
    passwordHash: "x".repeat(60),
    role,
    status: RecordState.ACTIVE,
  });
  return doc._id as Types.ObjectId;
}

async function grant(orgId: Types.ObjectId, userId: Types.ObjectId, role: UserRole) {
  await OrganizationMember.create({
    organizationId: orgId,
    userId,
    role,
    status: RecordState.ACTIVE,
  });
}

/** Sign in as a specific stored user for the duration of one assertion. */
async function actAs(userId: Types.ObjectId, role: UserRole) {
  if (sessionMock) sessionMock.restore();
  sessionMock = await mockSession({
    id: String(userId),
    name: "test",
    email: `${String(userId)}@payops.test`,
    role,
  });
  setNextHeaders({});
}

let rc: Types.ObjectId;
let tr: Types.ObjectId;
let gv: Types.ObjectId;

beforeEach(async () => {
  await ensureMongo();
  rc = await makeOrg("rentalconfirmation", true);
  tr = await makeOrg("tripreservations");
  gv = await makeOrg("globevista");
});

afterEach(() => {
  if (sessionMock) {
    sessionMock.restore();
    sessionMock = null;
  }
});

describe("ADMIN / SUPER_ADMIN global access", () => {
  it("SUPER_ADMIN sees all three organizations with ZERO membership rows", async () => {
    const uid = await makeUser(UserRole.SUPER_ADMIN, "su@payops.test");
    expect(await OrganizationMember.countDocuments({ userId: uid })).toBe(0);

    await actAs(uid, UserRole.SUPER_ADMIN);
    const orgs = await listMemberOrganizations();
    expect(orgs.map((o) => o.slug).sort()).toEqual([
      "globevista",
      "rentalconfirmation",
      "tripreservations",
    ]);
  });

  it("ADMIN likewise reaches every organization without memberships", async () => {
    const uid = await makeUser(UserRole.ADMIN, "admin@payops.test");
    await actAs(uid, UserRole.ADMIN);
    expect((await listMemberOrganizations()).map((o) => o.slug).sort()).toEqual([
      "globevista",
      "rentalconfirmation",
      "tripreservations",
    ]);
  });

  it("global access does NOT extend to a DISABLED organization (ADMIN)", async () => {
    await Organization.updateOne(
      { _id: tr },
      { $set: { status: RecordState.DISABLED } },
    );
    const uid = await makeUser(UserRole.ADMIN, "admin2@payops.test");
    await actAs(uid, UserRole.ADMIN);
    const slugs = (await listMemberOrganizations()).map((o) => o.slug);
    expect(slugs).not.toContain("tripreservations");
    expect(slugs).toContain("globevista");
  });

  it("nor for SUPER_ADMIN — the status filter binds every global role", async () => {
    await Organization.updateOne(
      { _id: gv },
      { $set: { status: RecordState.DISABLED } },
    );
    const uid = await makeUser(UserRole.SUPER_ADMIN, "su2@payops.test");
    await actAs(uid, UserRole.SUPER_ADMIN);
    const slugs = (await listMemberOrganizations()).map((o) => o.slug).sort();
    expect(slugs).toEqual(["rentalconfirmation", "tripreservations"]);
  });

  it("a global role cannot reach a DISABLED organization by passing its id directly", async () => {
    // The dangerous path: `listMemberOrganizations` governs the SWITCHER,
    // but an API route receives an organization id from the client. A
    // global role must not be able to hand over the id of an archived or
    // disabled tenant and have it accepted — otherwise "disabled" would
    // mean "hidden from the menu" rather than "not usable".
    await Organization.updateOne(
      { _id: gv },
      { $set: { status: RecordState.DISABLED } },
    );
    const uid = await makeUser(UserRole.SUPER_ADMIN, "su3@payops.test");
    await actAs(uid, UserRole.SUPER_ADMIN);
    await expect(assertOrganizationAccess(String(gv))).rejects.toThrow(
      /do not have access/i,
    );
    // ...while an ACTIVE one still resolves for the same caller.
    await expect(assertOrganizationAccess(String(rc))).resolves.toMatchObject({
      slug: "rentalconfirmation",
    });
  });

  it("an ARCHIVED organization is equally unreachable", async () => {
    await Organization.updateOne(
      { _id: tr },
      { $set: { status: RecordState.ARCHIVED } },
    );
    const uid = await makeUser(UserRole.ADMIN, "admin3@payops.test");
    await actAs(uid, UserRole.ADMIN);
    expect(
      (await listMemberOrganizations()).map((o) => o.slug),
    ).not.toContain("tripreservations");
  });
});

describe("normal users reach only what they are assigned", () => {
  it("one organization", async () => {
    const uid = await makeUser(UserRole.STAFF, "one@payops.test");
    await grant(rc, uid, UserRole.STAFF);
    await actAs(uid, UserRole.STAFF);
    expect((await listMemberOrganizations()).map((o) => o.slug)).toEqual([
      "rentalconfirmation",
    ]);
  });

  it("exactly two organizations", async () => {
    const uid = await makeUser(UserRole.STAFF, "two@payops.test");
    await grant(rc, uid, UserRole.STAFF);
    await grant(gv, uid, UserRole.STAFF);
    await actAs(uid, UserRole.STAFF);
    expect((await listMemberOrganizations()).map((o) => o.slug).sort()).toEqual([
      "globevista",
      "rentalconfirmation",
    ]);
  });

  it("all three, when explicitly granted", async () => {
    const uid = await makeUser(UserRole.STAFF, "all@payops.test");
    for (const o of [rc, tr, gv]) await grant(o, uid, UserRole.STAFF);
    await actAs(uid, UserRole.STAFF);
    expect((await listMemberOrganizations()).length).toBe(3);
  });

  it("access to Org A never exposes Org B", async () => {
    const uid = await makeUser(UserRole.STAFF, "scoped@payops.test");
    await grant(rc, uid, UserRole.STAFF);
    await actAs(uid, UserRole.STAFF);

    // The server-side guard, not a UI concern: a client-supplied id for an
    // organization the user does not hold must be refused.
    await expect(assertOrganizationAccess(String(gv))).rejects.toThrow(
      /do not have access/i,
    );
    await expect(assertOrganizationAccess(String(tr))).rejects.toThrow(
      /do not have access/i,
    );
    await expect(assertOrganizationAccess(String(rc))).resolves.toMatchObject({
      slug: "rentalconfirmation",
    });
  });

  it("a user with no memberships sees nothing", async () => {
    const uid = await makeUser(UserRole.STAFF, "none@payops.test");
    await actAs(uid, UserRole.STAFF);
    expect(await listMemberOrganizations()).toEqual([]);
  });
});

describe("revocation is immediate", () => {
  it("deactivating a membership removes server-side access on the next call", async () => {
    const uid = await makeUser(UserRole.STAFF, "revoke@payops.test");
    await grant(rc, uid, UserRole.STAFF);
    await grant(gv, uid, UserRole.STAFF);
    await actAs(uid, UserRole.STAFF);
    expect((await listMemberOrganizations()).length).toBe(2);

    await OrganizationMember.updateOne(
      { userId: uid, organizationId: gv },
      { $set: { status: RecordState.DISABLED } },
    );

    // Re-sign-in to clear React's per-request `cache()` memoisation.
    await actAs(uid, UserRole.STAFF);
    const after = await listMemberOrganizations();
    expect(after.map((o) => o.slug)).toEqual(["rentalconfirmation"]);
    await expect(assertOrganizationAccess(String(gv))).rejects.toThrow(
      /do not have access/i,
    );
  });

  it("revocation DEACTIVATES rather than deletes, preserving the audit trail", async () => {
    const admin = actorFor(UserRole.ADMIN);
    await actAs(new Types.ObjectId(admin.id), UserRole.ADMIN);

    const created = await createUser(
      {
        name: "Multi Org",
        email: "multi@payops.test",
        role: UserRole.STAFF,
        password: "Sup3rSecret!",
        organizationIds: [String(rc), String(gv)],
      },
      { actor: admin },
    );
    expect(
      await OrganizationMember.countDocuments({
        userId: new Types.ObjectId(created.id),
        status: RecordState.ACTIVE,
      }),
    ).toBe(2);

    await updateUser(
      created.id,
      { organizationIds: [String(rc)] },
      { actor: admin },
    );

    const rows = await OrganizationMember.find({
      userId: new Types.ObjectId(created.id),
    }).lean<{ organizationId: Types.ObjectId; status: RecordState }[]>();
    // Still TWO rows — one active, one disabled. Nothing was deleted.
    expect(rows.length).toBe(2);
    const gvRow = rows.find((r) => String(r.organizationId) === String(gv));
    expect(gvRow?.status).toBe(RecordState.DISABLED);
  });
});

describe("user creation assigns memberships without duplicating users", () => {
  it("creates ONE user row and N membership rows", async () => {
    const admin = actorFor(UserRole.ADMIN);
    await actAs(new Types.ObjectId(admin.id), UserRole.ADMIN);

    const created = await createUser(
      {
        name: "Select All",
        email: "selectall@payops.test",
        role: UserRole.STAFF,
        password: "Sup3rSecret!",
        organizationIds: [String(rc), String(tr), String(gv)],
      },
      { actor: admin },
    );

    expect(await User.countDocuments({ email: "selectall@payops.test" })).toBe(1);
    expect(
      await OrganizationMember.countDocuments({
        userId: new Types.ObjectId(created.id),
        status: RecordState.ACTIVE,
      }),
    ).toBe(3);
  });

  it("refuses a non-global user with no organizations", async () => {
    const admin = actorFor(UserRole.ADMIN);
    await actAs(new Types.ObjectId(admin.id), UserRole.ADMIN);
    await expect(
      createUser(
        {
          name: "Orphan",
          email: "orphan@payops.test",
          role: UserRole.STAFF,
          password: "Sup3rSecret!",
          organizationIds: [],
        },
        { actor: admin },
      ),
    ).rejects.toThrow(/at least one organization/i);
  });

  it("adding an organization later does NOT create a second user", async () => {
    const admin = actorFor(UserRole.ADMIN);
    await actAs(new Types.ObjectId(admin.id), UserRole.ADMIN);

    const created = await createUser(
      {
        name: "Grow",
        email: "grow@payops.test",
        role: UserRole.STAFF,
        password: "Sup3rSecret!",
        organizationIds: [String(rc)],
      },
      { actor: admin },
    );
    await updateUser(
      created.id,
      { organizationIds: [String(rc), String(gv)] },
      { actor: admin },
    );

    expect(await User.countDocuments({ email: "grow@payops.test" })).toBe(1);
    expect(
      await OrganizationMember.countDocuments({
        userId: new Types.ObjectId(created.id),
        status: RecordState.ACTIVE,
      }),
    ).toBe(2);
  });

  it("a global-role user needs no membership rows at all", async () => {
    const admin = actorFor(UserRole.SUPER_ADMIN);
    await actAs(new Types.ObjectId(admin.id), UserRole.SUPER_ADMIN);

    const created = await createUser(
      {
        name: "Global",
        email: "global@payops.test",
        role: UserRole.ADMIN,
        password: "Sup3rSecret!",
      },
      { actor: admin },
    );
    expect(
      await OrganizationMember.countDocuments({
        userId: new Types.ObjectId(created.id),
      }),
    ).toBe(0);

    await actAs(new Types.ObjectId(created.id), UserRole.ADMIN);
    expect((await listMemberOrganizations()).length).toBe(3);
  });
});

describe("incumbent behaviour is preserved", () => {
  it("an existing RentalConfirmation STAFF user's access is unchanged", async () => {
    // Exactly the shape a pre-existing user has: one explicit membership,
    // no role privilege. Nothing about this path was modified.
    const uid = await makeUser(UserRole.STAFF, "incumbent@payops.test");
    await grant(rc, uid, UserRole.STAFF);
    await actAs(uid, UserRole.STAFF);

    const orgs = await listMemberOrganizations();
    expect(orgs.map((o) => o.slug)).toEqual(["rentalconfirmation"]);
    // Critically: the new GlobeVista organization existing does NOT leak in.
    expect(orgs.map((o) => o.slug)).not.toContain("globevista");
  });
});
