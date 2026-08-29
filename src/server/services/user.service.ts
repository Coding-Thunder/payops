import "server-only";

import { Types } from "mongoose";

import {
  AuditAction,
  AuditEntity,
  RecordState,
  UserRole,
} from "@/lib/constants/enums";
import { DomainEventType } from "@/lib/constants/events";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/errors";
import { publishEvent } from "@/server/events/bus";
import type {
  CreateUserInput,
  ListUsersQuery,
  ResetUserPasswordInput,
  UpdateUserInput,
} from "@/lib/validation";
import { User, type UserDoc,
  Organization,
  OrganizationMember,
} from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import type { PublicUser } from "@/types";

import type { RequestContext } from "@/server/api/request-context";
import { hashPassword } from "@/server/auth/password";
import { recordAudit } from "./audit.service";

function toPublic(doc: UserDoc & { _id: Types.ObjectId | string }): PublicUser {
  return {
    id: String(doc._id),
    name: doc.name,
    email: doc.email,
    role: doc.role,
    status: doc.status,
    createdBy: doc.createdBy ? String(doc.createdBy) : null,
    lastLoginAt: doc.lastLoginAt ? doc.lastLoginAt.toISOString() : null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

interface UserActor {
  id: string;
  name: string;
  email: string;
  role: UserRole;
}

interface MutationContext {
  actor: UserActor;
  request?: RequestContext | null;
}

/** Only SUPER_ADMIN can manage SUPER_ADMIN accounts. */
function ensureCanManageRole(actor: UserActor, targetRole: UserRole) {
  if (targetRole === UserRole.SUPER_ADMIN && actor.role !== UserRole.SUPER_ADMIN) {
    throw new ForbiddenError("Only a super admin can manage super admins");
  }
}

export async function listUsers(query: ListUsersQuery) {
  await connectMongo();
  const filter: Record<string, unknown> = {};
  if (query.role) filter.role = query.role;
  if (query.status) filter.status = query.status;
  if (query.q) {
    // Cap + escape regex metacharacters to neutralise ReDoS payloads
    // (Mongo's regex engine is vulnerable to catastrophic backtracking).
    const raw = query.q.trim().slice(0, 60);
    const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$or = [
      { name: { $regex: escaped, $options: "i" } },
      { email: { $regex: escaped, $options: "i" } },
    ];
  }

  const { page, pageSize } = query;
  const [items, total] = await Promise.all([
    User.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean<(UserDoc & { _id: Types.ObjectId })[]>(),
    User.countDocuments(filter),
  ]);

  return {
    items: items.map(toPublic),
    total,
    page,
    pageSize,
  };
}

export async function getUserById(id: string): Promise<PublicUser> {
  await connectMongo();
  if (!Types.ObjectId.isValid(id)) throw new NotFoundError("User not found");
  const doc = await User.findById(id).lean<UserDoc & { _id: Types.ObjectId }>();
  if (!doc) throw new NotFoundError("User not found");
  return toPublic(doc);
}

/**
 * Reconcile a user's organization memberships to exactly `organizationIds`.
 *
 * Two rules that matter more than the mechanics:
 *
 *  1. REVOCATION DEACTIVATES, IT DOES NOT DELETE. `listMemberOrganizations`
 *     filters on `status: ACTIVE`, so flipping a row to DISABLED revokes
 *     access on the very next request while preserving the record that the
 *     user once had it — which is what an auditor asks for after an
 *     incident.
 *
 *  2. Ids are VALIDATED against real ACTIVE organizations before any write.
 *     Without that, a caller could mint a membership pointing at an
 *     arbitrary ObjectId; it would grant nothing today, but it is exactly
 *     the kind of junk row that later becomes a bug.
 *
 * Returns the slugs actually granted, for the audit metadata.
 */
async function syncOrganizationMemberships(
  userId: Types.ObjectId,
  role: UserRole,
  organizationIds: string[],
): Promise<{ granted: string[]; revoked: string[] }> {
  const valid = await Organization.find({
    _id: {
      $in: organizationIds
        .filter((id) => Types.ObjectId.isValid(id))
        .map((id) => new Types.ObjectId(id)),
    },
    status: RecordState.ACTIVE,
  })
    .select("_id slug")
    .lean<{ _id: Types.ObjectId; slug: string }[]>();

  const desired = new Map(valid.map((o) => [String(o._id), o.slug]));

  const current = await OrganizationMember.find({ userId })
    .select("organizationId status")
    .lean<
      { organizationId: Types.ObjectId; status: RecordState }[]
    >();
  const currentById = new Map(
    current.map((m) => [String(m.organizationId), m.status]),
  );

  const granted: string[] = [];
  const revoked: string[] = [];

  // Add or re-activate everything desired.
  for (const [orgId, slug] of desired) {
    const existing = currentById.get(orgId);
    if (existing === RecordState.ACTIVE) continue;
    await OrganizationMember.updateOne(
      { organizationId: new Types.ObjectId(orgId), userId },
      {
        $set: { status: RecordState.ACTIVE, role },
        $setOnInsert: {
          organizationId: new Types.ObjectId(orgId),
          userId,
        },
      },
      { upsert: true },
    );
    granted.push(slug);
  }

  // Deactivate anything held but no longer desired.
  for (const [orgId, status] of currentById) {
    if (desired.has(orgId) || status !== RecordState.ACTIVE) continue;
    await OrganizationMember.updateOne(
      { organizationId: new Types.ObjectId(orgId), userId },
      { $set: { status: RecordState.DISABLED } },
    );
    revoked.push(orgId);
  }

  return { granted, revoked };
}

/** Global roles reach every ACTIVE organization at the authorization layer,
 *  so membership rows are neither required nor meaningful for them. */
function roleHasGlobalOrgAccess(role: UserRole): boolean {
  return role === UserRole.ADMIN || role === UserRole.SUPER_ADMIN;
}

export async function createUser(
  input: CreateUserInput,
  ctx: MutationContext,
): Promise<PublicUser> {
  await connectMongo();
  ensureCanManageRole(ctx.actor, input.role);

  const existing = await User.exists({ email: input.email.toLowerCase() });
  if (existing) {
    throw new ConflictError("A user with that email already exists");
  }

  // A non-global user with no organization is an account that can sign in
  // and see nothing — refuse it at creation rather than shipping a
  // confusing empty shell. Only enforced once organizations exist, so a
  // pre-migration deployment keeps creating users exactly as before.
  const orgIds = input.organizationIds ?? [];
  const orgsExist = (await Organization.countDocuments({}).limit(1)) > 0;
  if (orgsExist && !roleHasGlobalOrgAccess(input.role) && orgIds.length === 0) {
    throw new ValidationError(
      "Select at least one organization for this user.",
    );
  }

  const passwordHash = await hashPassword(input.password);
  const doc = await User.create({
    name: input.name,
    email: input.email.toLowerCase(),
    passwordHash,
    role: input.role,
    status: RecordState.ACTIVE,
    createdBy: new Types.ObjectId(ctx.actor.id),
  });

  // Memberships AFTER the user exists, so the rows always reference a real
  // user. Skipped for global roles, which need none.
  let grantedSlugs: string[] = [];
  if (!roleHasGlobalOrgAccess(input.role) && orgIds.length > 0) {
    const res = await syncOrganizationMemberships(
      doc._id as Types.ObjectId,
      input.role,
      orgIds,
    );
    grantedSlugs = res.granted;
  }

  await recordAudit({
    action: AuditAction.USER_CREATED,
    entityType: AuditEntity.USER,
    entityId: String(doc._id),
    actor: { userId: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
    request: ctx.request ?? null,
    metadata: {
      email: doc.email,
      role: doc.role,
      organizations: roleHasGlobalOrgAccess(input.role)
        ? "ALL (global role)"
        : grantedSlugs,
    },
  });

  publishEvent({
    type: DomainEventType.USER_CREATED,
    audience: { kind: "admins" },
    actor: { id: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
    payload: {
      userId: String(doc._id),
      name: doc.name,
      email: doc.email,
      role: doc.role,
    },
  });

  return toPublic(doc.toObject() as UserDoc & { _id: Types.ObjectId });
}

export async function updateUser(
  id: string,
  input: UpdateUserInput,
  ctx: MutationContext,
): Promise<PublicUser> {
  await connectMongo();
  if (!Types.ObjectId.isValid(id)) throw new NotFoundError("User not found");
  const doc = await User.findById(id);
  if (!doc) throw new NotFoundError("User not found");

  ensureCanManageRole(ctx.actor, doc.role);
  if (input.role) ensureCanManageRole(ctx.actor, input.role);

  if (
    ctx.actor.id === String(doc._id) &&
    input.status &&
    input.status !== RecordState.ACTIVE
  ) {
    throw new ValidationError("You cannot disable or archive your own account");
  }
  if (
    ctx.actor.id === String(doc._id) &&
    input.role &&
    input.role !== doc.role
  ) {
    throw new ValidationError("You cannot change your own role");
  }

  const changes: Record<string, unknown> = {};
  let roleChanged = false;
  let statusChanged = false;
  if (input.name && input.name !== doc.name) {
    doc.name = input.name;
    changes.name = input.name;
  }
  if (input.role && input.role !== doc.role) {
    doc.role = input.role;
    changes.role = input.role;
    roleChanged = true;
  }
  if (input.status && input.status !== doc.status) {
    doc.status = input.status;
    changes.status = input.status;
    statusChanged = true;
  }

  // Membership reconciliation is a change in its own right, so it counts
  // toward the "did anything actually change" guard below — otherwise
  // editing ONLY a user's organizations would be rejected as a no-op.
  const nextRole = (input.role ?? doc.role) as UserRole;
  let membershipResult: { granted: string[]; revoked: string[] } | null = null;
  if (input.organizationIds !== undefined) {
    if (roleHasGlobalOrgAccess(nextRole)) {
      // A global role reaches every organization regardless. Accepting a
      // list here would write rows that grant nothing and imply a
      // restriction that is not real.
      changes.organizations = "ALL (global role)";
    } else {
      if (input.organizationIds.length === 0) {
        throw new ValidationError(
          "A user must belong to at least one organization.",
        );
      }
      membershipResult = await syncOrganizationMemberships(
        doc._id as Types.ObjectId,
        nextRole,
        input.organizationIds,
      );
      if (
        membershipResult.granted.length > 0 ||
        membershipResult.revoked.length > 0
      ) {
        changes.organizations = {
          granted: membershipResult.granted,
          revoked: membershipResult.revoked.length,
        };
      }
    }
  }

  // A user DEMOTED out of a global role keeps whatever explicit memberships
  // they had. If they have none, they would silently become an account with
  // no access at all, so require the caller to supply the list in the same
  // request.
  if (
    input.role !== undefined &&
    roleHasGlobalOrgAccess(doc.role) &&
    !roleHasGlobalOrgAccess(input.role) &&
    input.organizationIds === undefined
  ) {
    const held = await OrganizationMember.countDocuments({
      userId: doc._id,
      status: RecordState.ACTIVE,
    });
    if (held === 0) {
      throw new ValidationError(
        "Demoting this user removes their global access. Select the organizations they should keep.",
      );
    }
  }

  if (Object.keys(changes).length === 0) {
    throw new ValidationError("No changes to apply");
  }

  await doc.save();

  await recordAudit({
    action: roleChanged
      ? AuditAction.USER_ROLE_CHANGED
      : statusChanged
        ? input.status === RecordState.DISABLED
          ? AuditAction.USER_DISABLED
          : input.status === RecordState.ARCHIVED
            ? AuditAction.USER_ARCHIVED
            : AuditAction.USER_REACTIVATED
        : AuditAction.USER_UPDATED,
    entityType: AuditEntity.USER,
    entityId: String(doc._id),
    actor: { userId: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
    request: ctx.request ?? null,
    metadata: { changes },
  });

  publishEvent({
    type: DomainEventType.USER_UPDATED,
    audience: { kind: "admins" },
    actor: { id: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
    payload: {
      userId: String(doc._id),
      name: doc.name,
      changes,
    },
  });

  return toPublic(doc.toObject() as UserDoc & { _id: Types.ObjectId });
}

export async function resetUserPassword(
  id: string,
  input: ResetUserPasswordInput,
  ctx: MutationContext,
): Promise<void> {
  await connectMongo();
  if (!Types.ObjectId.isValid(id)) throw new NotFoundError("User not found");
  const doc = await User.findById(id);
  if (!doc) throw new NotFoundError("User not found");
  ensureCanManageRole(ctx.actor, doc.role);

  doc.passwordHash = await hashPassword(input.newPassword);
  await doc.save();

  await recordAudit({
    action: AuditAction.USER_PASSWORD_RESET,
    entityType: AuditEntity.USER,
    entityId: String(doc._id),
    actor: { userId: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
    request: ctx.request ?? null,
    metadata: { byActor: true },
  });
}

export async function touchLastLogin(userId: string): Promise<void> {
  await connectMongo();
  if (!Types.ObjectId.isValid(userId)) return;
  await User.updateOne(
    { _id: new Types.ObjectId(userId) },
    { $set: { lastLoginAt: new Date() } },
  );
}
