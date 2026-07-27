import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AuditAction,
  RecordState,
  UserRole,
} from "@/lib/constants/enums";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/errors";
import { AuditLog, OrgMember, User } from "@/server/db/models";
import {
  createUser,
  getUserById,
  resetUserPassword,
  setMemberPermissions,
  updateOwnName,
  updateUser,
} from "@/server/services/user.service";
import { actorFor } from "@/tests/utils/auth";
import { ensureMongo } from "@/tests/utils/db";
import { createOrgUser } from "@/tests/factories/user.factory";

// createUser now sends a REQUIRED invite email; stub the dispatch so these
// tests don't need a live SMTP transport. Minting + status derivation stay
// real (imported via ...actual).
vi.mock("@/server/services/team-invite.service", async (importActual) => {
  const actual =
    await importActual<typeof import("@/server/services/team-invite.service")>();
  return {
    ...actual,
    dispatchTeamInvite: vi.fn().mockResolvedValue(undefined),
  };
});

beforeEach(async () => {
  await ensureMongo();
});

describe("createUser", () => {
  it("provisions an invited (disabled) member with a pending single-use invite", async () => {
    const actor = actorFor(UserRole.SUPER_ADMIN);
    const out = await createUser(
      {
        name: "Grace Hopper",
        email: "grace@tracetxn.test",
        role: UserRole.ADMIN,
      },
      { actor, orgId: actor.orgId },
    );

    expect(out.email).toBe("grace@tracetxn.test");
    // Invited members are DISABLED (un-loginable) until they accept /join.
    expect(out.status).toBe(RecordState.DISABLED);
    expect(out.inviteStatus).toBe("invited");

    const doc = await User.findById(out.id).select("+passwordHash");
    // A real bcrypt hash of an unguessable random placeholder — the owner
    // never sets (or knows) the member's password.
    expect(doc?.passwordHash).toMatch(/^\$2[aby]\$\d{2}\$/);
    expect(doc?.status).toBe(RecordState.DISABLED);

    // The OrgMember carries a single-use, unused invite that was sent.
    const member = await OrgMember.findOne({ userId: doc?._id });
    expect(member?.invite?.tokenHash).toBeTruthy();
    expect(member?.invite?.usedAt ?? null).toBeNull();
    expect(member?.invite?.sentAt ?? null).not.toBeNull();

    const audit = await AuditLog.findOne({
      action: AuditAction.USER_CREATED,
      entityId: out.id,
    });
    expect(audit).not.toBeNull();
  });

  it("rejects a duplicate email with ConflictError", async () => {
    const actor = actorFor(UserRole.SUPER_ADMIN);
    await createUser(
      {
        name: "G",
        email: "dup@tracetxn.test",
        role: UserRole.STAFF,
      },
      { actor, orgId: actor.orgId },
    );
    await expect(
      createUser(
        {
          name: "G2",
          email: "dup@tracetxn.test",
          role: UserRole.STAFF,
        },
        { actor, orgId: actor.orgId },
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("ADMIN cannot create a SUPER_ADMIN", async () => {
    await expect(
      createUser(
        {
          name: "Sneak",
          email: "sneak@tracetxn.test",
          role: UserRole.SUPER_ADMIN,
        },
        { actor: actorFor(UserRole.ADMIN) },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("updateUser", () => {
  it("changes the role and emits a USER_ROLE_CHANGED audit", async () => {
    const actor = actorFor(UserRole.SUPER_ADMIN);
    const target = await createOrgUser(actor.orgId, { role: UserRole.ADMIN });

    const out = await updateUser(
      String(target._id),
      { role: UserRole.STAFF },
      { actor, orgId: actor.orgId },
    );
    expect(out.role).toBe(UserRole.STAFF);

    const audit = await AuditLog.findOne({
      action: AuditAction.USER_ROLE_CHANGED,
      entityId: String(target._id),
    });
    expect(audit).not.toBeNull();
  });

  it("ADMIN cannot demote a SUPER_ADMIN", async () => {
    const actor = actorFor(UserRole.ADMIN);
    const target = await createOrgUser(actor.orgId, {
      role: UserRole.SUPER_ADMIN,
    });
    await expect(
      updateUser(
        String(target._id),
        { role: UserRole.STAFF },
        { actor, orgId: actor.orgId },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("a user cannot disable their own account", async () => {
    const base = actorFor(UserRole.ADMIN);
    const target = await createOrgUser(base.orgId, { role: UserRole.ADMIN });
    // Actor IS the target (same id), acting inside their own org — so the
    // self-guard, not the org/membership check, is what must reject this.
    const selfActor = { ...base, id: String(target._id) };
    await expect(
      updateUser(
        String(target._id),
        { status: RecordState.DISABLED },
        { actor: selfActor, orgId: selfActor.orgId },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("a user cannot change their own role", async () => {
    const base = actorFor(UserRole.ADMIN);
    const target = await createOrgUser(base.orgId, { role: UserRole.ADMIN });
    const selfActor = { ...base, id: String(target._id) };
    await expect(
      updateUser(
        String(target._id),
        { role: UserRole.STAFF },
        { actor: selfActor, orgId: selfActor.orgId },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("returns NotFoundError for invalid ids", async () => {
    await expect(
      updateUser(
        "not-an-id",
        { name: "x" },
        { actor: actorFor(UserRole.SUPER_ADMIN) },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("resetUserPassword", () => {
  it("re-hashes the password and emits an audit row", async () => {
    const actor = actorFor(UserRole.SUPER_ADMIN);
    const target = await createOrgUser(actor.orgId, { role: UserRole.ADMIN });
    const before = await User.findById(target._id).select("+passwordHash");

    await resetUserPassword(
      String(target._id),
      { newPassword: "Hunter9Hunter9" },
      { actor, orgId: actor.orgId },
    );

    const after = await User.findById(target._id).select("+passwordHash");
    expect(after?.passwordHash).not.toBe(before?.passwordHash);

    const audit = await AuditLog.findOne({
      action: AuditAction.USER_PASSWORD_RESET,
      entityId: String(target._id),
    });
    expect(audit).not.toBeNull();
  });

  it("ADMIN cannot reset a SUPER_ADMIN's password", async () => {
    const actor = actorFor(UserRole.ADMIN);
    const target = await createOrgUser(actor.orgId, {
      role: UserRole.SUPER_ADMIN,
    });
    await expect(
      resetUserPassword(
        String(target._id),
        { newPassword: "Hunter9Hunter9" },
        { actor, orgId: actor.orgId },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("setMemberPermissions (Owner-only Team & Permissions writer)", () => {
  it("full mode persists an empty grant list", async () => {
    const owner = actorFor(UserRole.SUPER_ADMIN);
    const member = await createOrgUser(owner.orgId, { role: UserRole.STAFF });

    const out = await setMemberPermissions(
      String(member._id),
      { permissionMode: "full", permissions: ["customer:view"] },
      { actor: owner, orgId: owner.orgId },
    );
    expect(out.permissionMode).toBe("full");
    expect(out.permissions).toEqual([]);

    const reread = await getUserById(String(member._id), {
      orgId: owner.orgId!,
    });
    expect(reread.permissionMode).toBe("full");
    expect(reread.permissions).toEqual([]);
  });

  it("custom mode persists ONLY member-eligible grants — restricted keys are dropped", async () => {
    const owner = actorFor(UserRole.SUPER_ADMIN);
    const member = await createOrgUser(owner.orgId, { role: UserRole.STAFF });

    await setMemberPermissions(
      String(member._id),
      {
        permissionMode: "custom",
        permissions: [
          "customer:view", // member-eligible → kept
          "settings:update", // restricted → dropped
          "gateway:manage", // restricted → dropped
          "order:delete", // restricted → dropped
        ],
      },
      { actor: owner, orgId: owner.orgId },
    );

    const reread = await getUserById(String(member._id), {
      orgId: owner.orgId!,
    });
    expect(reread.permissionMode).toBe("custom");
    expect(reread.permissions).toEqual(["customer:view"]);

    const audit = await AuditLog.findOne({
      action: AuditAction.USER_PERMISSIONS_CHANGED,
      entityId: String(member._id),
    });
    expect(audit).not.toBeNull();
  });

  it("rejects editing your own permissions", async () => {
    const owner = actorFor(UserRole.SUPER_ADMIN);
    await expect(
      setMemberPermissions(
        owner.id,
        { permissionMode: "custom", permissions: [] },
        { actor: owner, orgId: owner.orgId },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects targeting an OWNER — owners always have full control", async () => {
    const owner = actorFor(UserRole.SUPER_ADMIN);
    const otherOwner = await createOrgUser(owner.orgId, {
      role: UserRole.SUPER_ADMIN,
    });
    await expect(
      setMemberPermissions(
        String(otherOwner._id),
        { permissionMode: "custom", permissions: ["customer:view"] },
        { actor: owner, orgId: owner.orgId },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("cannot touch a member of another org (cross-tenant 404)", async () => {
    const owner = actorFor(UserRole.SUPER_ADMIN);
    // A different actor → a different (random) orgId.
    const otherOrg = actorFor(UserRole.SUPER_ADMIN);
    const foreign = await createOrgUser(otherOrg.orgId, {
      role: UserRole.STAFF,
    });
    await expect(
      setMemberPermissions(
        String(foreign._id),
        { permissionMode: "custom", permissions: ["customer:view"] },
        { actor: owner, orgId: owner.orgId },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("updateOwnName (self-serve)", () => {
  it("updates ONLY the caller's own name and leaves role/status untouched", async () => {
    const actor = actorFor(UserRole.STAFF);
    const self = await createOrgUser(actor.orgId, {
      role: UserRole.STAFF,
      name: "Old Name",
    });
    const selfActor = { ...actor, id: String(self._id) };

    const out = await updateOwnName({ name: "New Name" }, { actor: selfActor });
    expect(out.name).toBe("New Name");

    const persisted = await User.findById(self._id);
    expect(persisted?.name).toBe("New Name");
    expect(persisted?.role).toBe(UserRole.STAFF);
    expect(persisted?.status).toBe(RecordState.ACTIVE);
  });
});
