import "server-only";

import { connectMongo } from "@/server/db/mongoose";
import { Organization, User, Types } from "@/server/db/models";
import {
  buildPageResult,
  type Pagination,
  type PageResult,
} from "@/server/pagination";

export interface UserRow {
  id: string;
  name: string;
  email: string;
  role: string;
  status: string;
  orgName: string | null;
  lastLoginAt: string | null;
  createdAt: string | null;
}

export async function listUsers(
  p: Pagination,
  search?: string,
): Promise<PageResult<UserRow>> {
  await connectMongo();
  const filter: Record<string, unknown> = {};
  if (search && search.trim()) {
    // Escape regex metacharacters — the search box is untrusted input.
    const safe = search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rx = new RegExp(safe, "i");
    filter.$or = [{ email: rx }, { name: rx }];
  }

  const [docs, total] = await Promise.all([
    User.find(filter)
      .sort({ createdAt: -1 })
      .skip(p.skip)
      .limit(p.limit)
      .select({ name: 1, email: 1, role: 1, status: 1, primaryOrgId: 1, lastLoginAt: 1, createdAt: 1 })
      .lean<
        {
          _id: Types.ObjectId;
          name: string;
          email: string;
          role: string;
          status: string;
          primaryOrgId?: Types.ObjectId | null;
          lastLoginAt?: Date | null;
          createdAt?: Date | null;
        }[]
      >(),
    User.countDocuments(filter),
  ]);

  const orgIds = docs
    .map((d) => d.primaryOrgId)
    .filter((v): v is Types.ObjectId => v != null);
  const orgs = orgIds.length
    ? await Organization.find({ _id: { $in: orgIds } })
        .select({ name: 1 })
        .lean<{ _id: Types.ObjectId; name: string }[]>()
    : [];
  const orgById = new Map(orgs.map((o) => [String(o._id), o.name]));

  const items: UserRow[] = docs.map((d) => ({
    id: String(d._id),
    name: d.name,
    email: d.email,
    role: d.role,
    status: d.status,
    orgName: d.primaryOrgId ? orgById.get(String(d.primaryOrgId)) ?? null : null,
    lastLoginAt: d.lastLoginAt ? new Date(d.lastLoginAt).toISOString() : null,
    createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : null,
  }));

  return buildPageResult(items, total, p);
}

export type UserStatus = "ACTIVE" | "DISABLED";

/** Flip a user between ACTIVE and DISABLED. Returns the new status, or
 *  null when the id is invalid / the user doesn't exist. */
export async function setUserStatus(
  userId: string,
  status: UserStatus,
): Promise<UserStatus | null> {
  if (!Types.ObjectId.isValid(userId)) return null;
  await connectMongo();
  const res = await User.updateOne(
    { _id: new Types.ObjectId(userId) },
    { $set: { status } },
  );
  if (res.matchedCount === 0) return null;
  return status;
}

/**
 * Guard info for destructive actions on a user. Returns the target's
 * email and whether they own any Organization (disabling an org owner
 * would lock every member out of that tenant), or null if not found.
 */
export async function getUserGuardInfo(
  userId: string,
): Promise<{ email: string; isOrgOwner: boolean } | null> {
  if (!Types.ObjectId.isValid(userId)) return null;
  await connectMongo();
  const oid = new Types.ObjectId(userId);
  const [user, ownsOrg] = await Promise.all([
    User.findById(oid).select({ email: 1 }).lean<{ email: string } | null>(),
    Organization.exists({ ownerUserId: oid }),
  ]);
  if (!user) return null;
  return { email: user.email, isOrgOwner: Boolean(ownsOrg) };
}
