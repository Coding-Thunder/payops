import { beforeEach, describe, expect, it } from "vitest";

import {
  AuditAction,
  AuditEntity,
  RecordState,
  UserRole,
} from "@/lib/constants/enums";
import { Permission, roleHasPermission } from "@/lib/constants/permissions";
import { AuditLog, User } from "@/server/db/models";
import { verifySession } from "@/server/auth/jwt";
import { authenticate } from "@/server/services/auth.service";
import { recordAudit } from "@/server/services/audit.service";
import { getUserById, listUsers } from "@/server/services/user.service";
import { createStaff, createSuperAdmin } from "@/tests/factories/user.factory";
import { ensureMongo } from "@/tests/utils/db";

/**
 * Hiding an account from the Team members list.
 *
 * `hiddenFromTeamList` is a display preference on the user document, and the
 * whole point of these tests is that it is ONLY that. An operator who does
 * not want their own row on the Team page should not, as a side effect, lose
 * their session, their role, their permissions or their name on an audit
 * trail — and none of those paths read the flag.
 *
 * This is explicitly not a security control. A hidden account is a real
 * SUPER_ADMIN; anyone who can reach the database or the audit log sees it.
 */

const QUERY = { page: 1, pageSize: 50 } as const;

beforeEach(async () => {
  await ensureMongo();
});

describe("the Team members list", () => {
  it("omits a hidden account", async () => {
    await createSuperAdmin({
      email: "hidden@payops.test",
      hiddenFromTeamList: true,
    });

    const { items } = await listUsers(QUERY);
    expect(items.map((u) => u.email)).not.toContain("hidden@payops.test");
  });

  it("still lists everyone else", async () => {
    await createSuperAdmin({
      email: "hidden@payops.test",
      hiddenFromTeamList: true,
    });
    await createStaff({ email: "visible-one@payops.test" });
    await createStaff({ email: "visible-two@payops.test" });

    const emails = (await listUsers(QUERY)).items.map((u) => u.email);
    expect(emails).toContain("visible-one@payops.test");
    expect(emails).toContain("visible-two@payops.test");
    expect(emails).not.toContain("hidden@payops.test");
  });

  it("excludes the hidden account from the total, so pagination stays honest", async () => {
    await createStaff({ email: "visible@payops.test" });
    await createSuperAdmin({
      email: "hidden@payops.test",
      hiddenFromTeamList: true,
    });

    const { total, items } = await listUsers(QUERY);
    expect(total).toBe(1);
    expect(items).toHaveLength(1);
  });

  it("lists accounts written before the field existed", async () => {
    // `$ne: true` and not `false`: documents from before this change carry
    // no such field at all, and must keep appearing.
    await createStaff({ email: "legacy@payops.test" });
    await User.collection.updateOne(
      { email: "legacy@payops.test" },
      { $unset: { hiddenFromTeamList: "" } },
    );

    const emails = (await listUsers(QUERY)).items.map((u) => u.email);
    expect(emails).toContain("legacy@payops.test");
  });

  it("hides nothing when a search filter is applied either", async () => {
    await createSuperAdmin({
      name: "Hidden Person",
      email: "hidden@payops.test",
      hiddenFromTeamList: true,
    });

    const { items } = await listUsers({ ...QUERY, q: "Hidden" });
    expect(items).toHaveLength(0);
  });

  it("returns the account when a caller explicitly asks for hidden ones", async () => {
    await createSuperAdmin({
      email: "hidden@payops.test",
      hiddenFromTeamList: true,
    });

    const { items } = await listUsers(QUERY, { includeHidden: true });
    expect(items.map((u) => u.email)).toContain("hidden@payops.test");
  });
});

describe("a hidden account is otherwise untouched", () => {
  it("can still sign in", async () => {
    await createSuperAdmin({
      email: "hidden@payops.test",
      password: "Hunter2Hunter2",
      hiddenFromTeamList: true,
    });

    const result = await authenticate(
      { email: "hidden@payops.test", password: "Hunter2Hunter2" },
      { ip: "1.2.3.4", userAgent: "vitest", requestId: "req-hidden" },
    );

    expect(result.token).toBeTruthy();
    const payload = await verifySession(result.token);
    expect(payload).not.toBeNull();
    expect(payload?.role).toBe(UserRole.SUPER_ADMIN);
  });

  it("keeps its role, status and permissions", async () => {
    const user = await createSuperAdmin({
      email: "hidden@payops.test",
      hiddenFromTeamList: true,
    });

    const fetched = await getUserById(String(user._id));
    expect(fetched.role).toBe(UserRole.SUPER_ADMIN);
    expect(fetched.status).toBe(RecordState.ACTIVE);
    expect(fetched.hiddenFromTeamList).toBe(true);

    // The flag lives nowhere near authorisation. Both of these are
    // privileged enough that losing them would be obvious.
    expect(roleHasPermission(fetched.role, Permission.USER_DISABLE)).toBe(true);
    expect(roleHasPermission(fetched.role, Permission.AUDIT_DELETE)).toBe(true);
  });

  it("is still resolvable by id — the account can reach itself", async () => {
    const user = await createSuperAdmin({
      email: "hidden@payops.test",
      hiddenFromTeamList: true,
    });

    await expect(getUserById(String(user._id))).resolves.toMatchObject({
      email: "hidden@payops.test",
    });
  });

  it("still reads correctly as an audit actor", async () => {
    const user = await createSuperAdmin({
      name: "Hidden Person",
      email: "hidden@payops.test",
      hiddenFromTeamList: true,
    });

    await recordAudit({
      action: AuditAction.USER_UPDATED,
      entityType: AuditEntity.USER,
      entityId: String(user._id),
      actor: {
        userId: String(user._id),
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });

    const row = await AuditLog.findOne({ entityId: String(user._id) }).lean<{
      actor: { userId?: unknown; name?: string; email?: string; role?: string };
    }>();
    expect(row?.actor.name).toBe("Hidden Person");
    expect(row?.actor.email).toBe("hidden@payops.test");
    expect(row?.actor.role).toBe(UserRole.SUPER_ADMIN);
    expect(String(row?.actor.userId)).toBe(String(user._id));
  });
});
