import "server-only";

import { cache } from "react";

import { ForbiddenError, UnauthorizedError } from "@/lib/errors";
import {
  Permission,
  roleHasAnyPermission,
  roleHasPermission,
} from "@/lib/constants/permissions";
import { UserRole } from "@/lib/constants/enums";
import { User } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";

import { readSessionCookie } from "./cookies";
import { verifySession, type SessionPayload } from "./jwt";

export interface AuthenticatedUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  /** Active organization id for this session. Resolved from the JWT
   *  claim when present (new logins) or from `User.primaryOrgId` as a
   *  fallback (legacy tokens issued before the multi-tenant migration).
   *  Null only when the user has no membership at all, which should
   *  never happen post-migration. Treat `null` as a fatal session
   *  state and force re-login at the call site. */
  orgId: string | null;
  /** All org memberships the user has (any status). Populated lazily -
   *  callers that don't need the full list can ignore. */
  orgIds: string[];
}

/**
 * Cached per request via React.cache - safe to call from multiple server components.
 * Returns null when there is no valid session or the user has been disabled.
 */
export const getCurrentUser = cache(
  async (): Promise<AuthenticatedUser | null> => {
    const token = await readSessionCookie();
    if (!token) return null;
    const payload = await verifySession(token);
    if (!payload) return null;
    return validatedUserFromPayload(payload);
  },
);

async function validatedUserFromPayload(
  payload: SessionPayload,
): Promise<AuthenticatedUser | null> {
  await connectMongo();
  const user = await User.findById(payload.sub).lean<{
    _id: unknown;
    name: string;
    email: string;
    role: UserRole;
    status: string;
    primaryOrgId?: unknown;
  }>();
  if (!user) return null;
  if (user.status !== "ACTIVE") return null;
  // Resolve the active org. JWT claim wins (an explicit org-switch must
  // be respected even if the user's primary changed). Falls back to the
  // user's primary org so legacy tokens issued before the multi-tenant
  // migration keep working without forcing a re-login.
  const orgId = payload.orgId ?? (user.primaryOrgId ? String(user.primaryOrgId) : null);
  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    role: user.role,
    orgId,
    orgIds: payload.orgIds ?? (orgId ? [orgId] : []),
  };
}

export async function requireUser(): Promise<AuthenticatedUser> {
  const u = await getCurrentUser();
  if (!u) throw new UnauthorizedError();
  return u;
}

export async function requirePermission(
  permission: Permission,
): Promise<AuthenticatedUser> {
  const u = await requireUser();
  if (!roleHasPermission(u.role, permission)) throw new ForbiddenError();
  return u;
}

export async function requireAnyPermission(
  permissions: readonly Permission[],
): Promise<AuthenticatedUser> {
  const u = await requireUser();
  if (!roleHasAnyPermission(u.role, permissions)) throw new ForbiddenError();
  return u;
}

export async function requireRole(
  roles: UserRole | UserRole[],
): Promise<AuthenticatedUser> {
  const u = await requireUser();
  const allowed = Array.isArray(roles) ? roles : [roles];
  if (!allowed.includes(u.role)) throw new ForbiddenError();
  return u;
}

/**
 * Tenant-aware variant: returns the authenticated user AND guarantees a
 * non-null `orgId`. Callers that need to build an `OrgContext` should
 * use this, never read `user.orgId` directly without a null check.
 *
 * Throws UnauthorizedError when no session is present and ForbiddenError
 * when the session exists but has no resolvable org (data inconsistency
 *, the only way to land here is if the migration script never ran for
 * this user, or every membership was deleted).
 */
export async function requireOrgUser(): Promise<
  AuthenticatedUser & { orgId: string }
> {
  const u = await requireUser();
  if (!u.orgId) {
    throw new ForbiddenError(
      "Your account is not attached to any organization. Contact support.",
    );
  }
  return u as AuthenticatedUser & { orgId: string };
}
