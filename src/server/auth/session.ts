import "server-only";

import { cache } from "react";

import { Types } from "mongoose";

import { ForbiddenError, UnauthorizedError } from "@/lib/errors";
import {
  Permission,
  resolveEffectivePermissions,
  toWorkspaceRole,
  type MemberPermissionMode,
  type WorkspaceRole,
} from "@/lib/constants/permissions";
import { UserRole } from "@/lib/constants/enums";
import { OrgMember, User } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";

import { readSessionCookie } from "./cookies";
import { verifySession, type SessionPayload } from "./jwt";

export interface AuthenticatedUser {
  id: string;
  name: string;
  email: string;
  /** The user's role IN THE ACTIVE WORKSPACE (from the OrgMember row when
   *  present; falls back to User.role for legacy sessions). */
  role: UserRole;
  /** Two-role product view of `role`: OWNER controls the workspace, MEMBER
   *  operates it. */
  workspaceRole: WorkspaceRole;
  /** The EFFECTIVE permission set for the active workspace — the single
   *  authority `requirePermission` consults. Resolved from the member's
   *  role + permission mode + custom grants, with the restricted set removed.
   *  Members can never hold an owner-only capability regardless of what a
   *  stale token or request payload claims. */
  permissions: ReadonlySet<Permission>;
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
  /** Non-null ONLY when this session was minted by the founder console's
   *  impersonation flow. `by` = the platform admin's email; `observeOnly`
   *  means the proxy blocks every state-changing request. The app shell
   *  renders a persistent banner while this is set. */
  impersonation: { by: string; observeOnly: boolean } | null;
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

type UserLean = {
  _id: unknown;
  name: string;
  email: string;
  role: UserRole;
  status: string;
  primaryOrgId?: unknown;
};
type MemberLean = {
  role?: UserRole;
  permissionMode?: MemberPermissionMode;
  permissions?: string[];
} | null;

async function validatedUserFromPayload(
  payload: SessionPayload,
): Promise<AuthenticatedUser | null> {
  await connectMongo();

  // Fast path: current tokens carry `orgId`, so the membership query's keys
  // (orgId from the token, userId = payload.sub) are known WITHOUT the user
  // doc — both reads run in parallel, halving auth latency on the app's
  // highest-frequency path. Legacy no-orgId tokens keep the serial path (the
  // org is derived from the user's primaryOrgId, which needs the user first).
  const jwtOrgId =
    payload.orgId && Types.ObjectId.isValid(payload.orgId)
      ? payload.orgId
      : null;

  const userQuery = User.findById(payload.sub).lean<UserLean>();
  const findMember = (org: string) =>
    OrgMember.findOne({
      orgId: new Types.ObjectId(org),
      userId: new Types.ObjectId(String(payload.sub)),
      status: "ACTIVE",
    })
      .select({ role: 1, permissionMode: 1, permissions: 1 })
      .lean<MemberLean>();

  let user: UserLean | null;
  let member: MemberLean = null;
  let memberResolved = false;
  if (jwtOrgId) {
    [user, member] = await Promise.all([userQuery, findMember(jwtOrgId)]);
    memberResolved = true;
  } else {
    user = await userQuery;
  }

  if (!user) return null;
  if (user.status !== "ACTIVE") return null;

  // Resolve the active org. JWT claim wins (an explicit org-switch must be
  // respected even if the user's primary changed). Falls back to the user's
  // primary org so legacy tokens keep working without forcing a re-login.
  const orgId =
    payload.orgId ?? (user.primaryOrgId ? String(user.primaryOrgId) : null);

  // Legacy path only: now that the primary org is known, resolve membership.
  // (The fast path already fetched it in parallel above.) The per-org role +
  // permission config is authoritative for authorization; falls back to
  // User.role for legacy sessions with no membership row.
  if (!memberResolved && orgId && Types.ObjectId.isValid(orgId)) {
    member = await findMember(orgId);
  }

  let effectiveRole: UserRole = user.role;
  let permissionMode: MemberPermissionMode = "full";
  let customGrants: string[] = [];
  if (member) {
    effectiveRole = member.role ?? user.role;
    permissionMode = member.permissionMode ?? "full";
    customGrants = member.permissions ?? [];
  }

  const permissions = resolveEffectivePermissions({
    role: effectiveRole,
    permissionMode,
    customGrants,
  });

  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    role: effectiveRole,
    workspaceRole: toWorkspaceRole(effectiveRole),
    permissions,
    orgId,
    orgIds: payload.orgIds ?? (orgId ? [orgId] : []),
    impersonation: payload.imp
      ? { by: payload.imp.by, observeOnly: payload.imp.obs }
      : null,
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
  if (!u.permissions.has(permission)) throw new ForbiddenError();
  return u;
}

export async function requireAnyPermission(
  permissions: readonly Permission[],
): Promise<AuthenticatedUser> {
  const u = await requireUser();
  if (!permissions.some((p) => u.permissions.has(p))) throw new ForbiddenError();
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

/**
 * Workspace-OWNER gate. The hard actor check for owner-only operations
 * (e.g. changing a member's permissions) that must be enforced
 * independently of any single mutable permission — a MEMBER can never be an
 * OWNER regardless of what their raw role or a stale token claims, because
 * workspaceRole is derived server-side from the active OrgMember row on
 * every request. Also guarantees a non-null orgId.
 */
export async function requireOwner(): Promise<
  AuthenticatedUser & { orgId: string }
> {
  const u = await requireUser();
  if (u.workspaceRole !== "OWNER") throw new ForbiddenError();
  if (!u.orgId) {
    throw new ForbiddenError(
      "Your account is not attached to any organization. Contact support.",
    );
  }
  return u as AuthenticatedUser & { orgId: string };
}
