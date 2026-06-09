import { beforeEach, describe, expect, it } from "vitest";

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
import { AuditLog, User } from "@/server/db/models";
import {
  createUser,
  resetUserPassword,
  updateUser,
} from "@/server/services/user.service";
import { actorFor } from "@/tests/utils/auth";
import { ensureMongo } from "@/tests/utils/db";
import { createAdmin, createSuperAdmin } from "@/tests/factories/user.factory";

beforeEach(async () => {
  await ensureMongo();
});

describe("createUser", () => {
  it("hashes the password and creates an active user", async () => {
    const actor = actorFor(UserRole.SUPER_ADMIN);
    const out = await createUser(
      {
        name: "Grace Hopper",
        email: "grace@tracetxn.test",
        role: UserRole.ADMIN,
        password: "Hunter2Hunter2",
      },
      { actor },
    );

    expect(out.email).toBe("grace@tracetxn.test");
    expect(out.status).toBe(RecordState.ACTIVE);

    const doc = await User.findById(out.id).select("+passwordHash");
    expect(doc?.passwordHash).toMatch(/^\$2[aby]\$\d{2}\$/);
    expect(doc?.passwordHash).not.toContain("Hunter2");

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
        password: "Hunter2Hunter2",
      },
      { actor },
    );
    await expect(
      createUser(
        {
          name: "G2",
          email: "dup@tracetxn.test",
          role: UserRole.STAFF,
          password: "Hunter2Hunter2",
        },
        { actor },
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
          password: "Hunter2Hunter2",
        },
        { actor: actorFor(UserRole.ADMIN) },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("updateUser", () => {
  it("changes the role and emits a USER_ROLE_CHANGED audit", async () => {
    const actor = actorFor(UserRole.SUPER_ADMIN);
    const target = await createAdmin();

    const out = await updateUser(
      String(target._id),
      { role: UserRole.STAFF },
      { actor },
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
    const target = await createSuperAdmin();
    await expect(
      updateUser(
        String(target._id),
        { role: UserRole.STAFF },
        { actor },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("a user cannot disable their own account", async () => {
    const target = await createAdmin();
    const selfActor = actorFor(UserRole.ADMIN, {
      id: String(target._id),
      email: target.email,
      name: target.name,
    });
    await expect(
      updateUser(
        String(target._id),
        { status: RecordState.DISABLED },
        { actor: selfActor },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("a user cannot change their own role", async () => {
    const target = await createAdmin();
    const selfActor = actorFor(UserRole.ADMIN, {
      id: String(target._id),
      email: target.email,
      name: target.name,
    });
    await expect(
      updateUser(
        String(target._id),
        { role: UserRole.STAFF },
        { actor: selfActor },
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
    const target = await createAdmin();
    const before = await User.findById(target._id).select("+passwordHash");

    await resetUserPassword(
      String(target._id),
      { newPassword: "Hunter9Hunter9" },
      { actor },
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
    const target = await createSuperAdmin();
    await expect(
      resetUserPassword(
        String(target._id),
        { newPassword: "Hunter9Hunter9" },
        { actor },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
