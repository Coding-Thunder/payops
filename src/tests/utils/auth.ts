import { Types } from "mongoose";
import { vi } from "vitest";

import { UserRole } from "@/lib/constants/enums";
import { ForbiddenError, UnauthorizedError } from "@/lib/errors";
import {
  type Permission,
  roleHasAnyPermission,
  roleHasPermission,
} from "@/lib/constants/permissions";
import type { AuthenticatedUser } from "@/server/auth/session";

/**
 * Auth test helpers.
 *
 *   - `actorFor(role)` produces a deterministic `AuthenticatedUser`.
 *   - `mockSession(user)` patches `@/server/auth/session` so route
 *     handlers believe a user is signed in. The mock HONOURS the real
 *     role/permission matrix — calling `requirePermission(X)` with a
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
  role: UserRole = UserRole.ADMIN,
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
    orgId,
    orgIds: [orgId],
  };
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
      if (!roleHasPermission(user.role, p)) throw new ForbiddenError();
      return user;
    });

  const requireAnyPermission = vi
    .spyOn(sessionModule, "requireAnyPermission")
    .mockImplementation(async (perms: readonly Permission[]) => {
      if (!user) throw new UnauthorizedError();
      if (!roleHasAnyPermission(user.role, perms)) throw new ForbiddenError();
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
