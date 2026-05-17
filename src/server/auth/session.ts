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
  }>();
  if (!user) return null;
  if (user.status !== "ACTIVE") return null;
  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    role: user.role,
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
