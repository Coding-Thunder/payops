import { Types } from "mongoose";
import { vi } from "vitest";

import { RecordState, UserRole } from "@/lib/constants/enums";
import { ForbiddenError, UnauthorizedError } from "@/lib/errors";
import {
  resolveEffectivePermissions,
  toWorkspaceRole,
  type Permission,
} from "@/lib/constants/permissions";
import { Organization, User } from "@/server/db/models";
import type { AuthenticatedUser } from "@/server/auth/session";

/**
 * Auth test helpers.
 *
 *   - `actorFor(role)` produces a deterministic `AuthenticatedUser`.
 *   - `mockSession(user)` patches `@/server/auth/session` so route
 *     handlers believe a user is signed in. The mock HONOURS the real
 *     role/permission matrix, calling `requirePermission(X)` with a
 *     role that doesn't grant X throws `ForbiddenError`, exactly like
 *     production. A test for "STAFF can't reach /admin/*" must work
 *     against the same RBAC code path the app does.
 */

interface ActorOptions {
  id?: string;
  name?: string;
  email?: string;
}

export function actorFor(
  // Default to the workspace OWNER (SUPER_ADMIN): most tests just need "an
  // authorized user who can do the thing". Tests exercising MEMBER limits or
  // role boundaries pass an explicit role.
  role: UserRole = UserRole.SUPER_ADMIN,
  opts: ActorOptions = {},
): AuthenticatedUser {
  const id = opts.id ?? new Types.ObjectId().toString();
  // Tests get a deterministic legacy-style orgId so they never have to
  // think about the tenant boundary unless they're testing it. A new
  // ObjectId per call mirrors how production users land post-migration.
  const orgId = new Types.ObjectId().toString();
  return {
    id,
    name: opts.name ?? `${role} User`,
    email: opts.email ?? `${role.toLowerCase()}@tracetxn.test`,
    role,
    workspaceRole: toWorkspaceRole(role),
    // Mirrors the production session guard: members get the operational set,
    // owners get everything.
    permissions: resolveEffectivePermissions({ role, permissionMode: "full" }),
    orgId,
    orgIds: [orgId],
    impersonation: null,
  };
}

/**
 * Persist an Organization + owner User for an actor's orgId so tenant-
 * aware services (Branding, Workflow, etc.) that lazy-seed from the
 * Org/founder data have something to read. Idempotent, safe to call
 * multiple times for the same actor.
 *
 * Tests that exercise any flow touching branding/workflow/email seeds
 * should call this in `beforeEach`. Tests that only exercise tenant-
 * agnostic pure logic don't need it.
 */
export async function persistOrgFixture(
  actor: AuthenticatedUser,
): Promise<void> {
  if (!actor.orgId) return;
  const orgId = new Types.ObjectId(actor.orgId);

  // Idempotent: if the Org already exists, we're done. Stops repeat
  // calls from inserting duplicate users that collide on the email
  // unique index.
  const existing = await Organization.findById(orgId).select({ _id: 1 }).lean();
  if (existing) return;

  const userId = new Types.ObjectId(actor.id);
  await User.create({
    _id: userId,
    name: actor.name,
    email: actor.email,
    passwordHash: "test:placeholder",
    role: actor.role,
    status: RecordState.ACTIVE,
    primaryOrgId: orgId,
  });
  await Organization.create({
    _id: orgId,
    slug: `test-${orgId.toString().slice(-8)}`,
    name: `${actor.name}'s Workspace`,
    ownerUserId: userId,
    status: "ACTIVE",
  });
}

export interface MockSessionHandle {
  user: AuthenticatedUser;
  restore: () => void;
}

export async function mockSession(
  user: AuthenticatedUser | null,
): Promise<MockSessionHandle> {
  const sessionModule = await import("@/server/auth/session");

  const getCurrentUser = vi
    .spyOn(sessionModule, "getCurrentUser")
    .mockImplementation(async () => user);

  const requireUser = vi
    .spyOn(sessionModule, "requireUser")
    .mockImplementation(async () => {
      if (!user) throw new UnauthorizedError();
      return user;
    });

  const requirePermission = vi
    .spyOn(sessionModule, "requirePermission")
    .mockImplementation(async (p: Permission) => {
      if (!user) throw new UnauthorizedError();
      // Faithful to production: check the actor's EFFECTIVE permission set,
      // not the raw role matrix.
      if (!user.permissions.has(p)) throw new ForbiddenError();
      return user;
    });

  const requireAnyPermission = vi
    .spyOn(sessionModule, "requireAnyPermission")
    .mockImplementation(async (perms: readonly Permission[]) => {
      if (!user) throw new UnauthorizedError();
      if (!perms.some((p) => user.permissions.has(p))) throw new ForbiddenError();
      return user;
    });

  const requireRole = vi
    .spyOn(sessionModule, "requireRole")
    .mockImplementation(async (roles: UserRole | UserRole[]) => {
      if (!user) throw new UnauthorizedError();
      const allowed = Array.isArray(roles) ? roles : [roles];
      if (!allowed.includes(user.role)) throw new ForbiddenError();
      return user;
    });

  return {
    user: user ?? (null as never),
    restore() {
      getCurrentUser.mockRestore();
      requireUser.mockRestore();
      requirePermission.mockRestore();
      requireAnyPermission.mockRestore();
      requireRole.mockRestore();
    },
  };
}
