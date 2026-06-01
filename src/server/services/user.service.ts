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
import { OrgMember, User, type UserDoc } from "@/server/db/models";
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
  /** Active organization. Threaded for SSE event scoping + audit
   *  orgId stamping. Optional for back-compat with un-migrated
   *  callers; new routes pass it from `actor.orgId`. */
  orgId?: string | null;
  request?: RequestContext | null;
}

/** Only SUPER_ADMIN can manage SUPER_ADMIN accounts. */
function ensureCanManageRole(actor: UserActor, targetRole: UserRole) {
  if (targetRole === UserRole.SUPER_ADMIN && actor.role !== UserRole.SUPER_ADMIN) {
    throw new ForbiddenError("Only a super admin can manage super admins");
  }
}

/**
 * Resolve the userIds that belong to a given org via the OrgMember
 * join. Used by every user-management read so admins of org A never
 * see — or operate on — users from org B.
 *
 * Membership is the source of truth: User.primaryOrgId is informative
 * but not authoritative (a user could be invited to a second org and
 * their primaryOrgId would still point at the first).
 */
async function memberUserIdsForOrg(orgId: string): Promise<Types.ObjectId[]> {
  const memberships = await OrgMember.find({
    orgId: new Types.ObjectId(orgId),
    status: { $ne: RecordState.ARCHIVED },
  })
    .select({ userId: 1, _id: 0 })
    .lean<{ userId: Types.ObjectId }[]>();
  return memberships.map((m) => m.userId);
}

async function assertMember(orgId: string, userId: string): Promise<void> {
  const exists = await OrgMember.exists({
    orgId: new Types.ObjectId(orgId),
    userId: new Types.ObjectId(userId),
    status: { $ne: RecordState.ARCHIVED },
  });
  if (!exists) throw new NotFoundError("User not found");
}

interface ScopedListContext {
  orgId: string;
}

export async function listUsers(
  query: ListUsersQuery,
  ctx: ScopedListContext,
) {
  await connectMongo();
  const memberIds = await memberUserIdsForOrg(ctx.orgId);
  // No members yet — short-circuit to an empty page so the rest of the
  // query never sees a filter that would match the global collection.
  if (memberIds.length === 0) {
    return { items: [], total: 0, page: query.page, pageSize: query.pageSize };
  }

  const filter: Record<string, unknown> = { _id: { $in: memberIds } };
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

interface ScopedByIdContext {
  orgId: string;
}

export async function getUserById(
  id: string,
  ctx: ScopedByIdContext,
): Promise<PublicUser> {
  await connectMongo();
  if (!Types.ObjectId.isValid(id)) throw new NotFoundError("User not found");
  // Membership pin first — strangers get the same 404 a missing user
  // gets, so an admin of org A can't enumerate ids that belong to org B.
  await assertMember(ctx.orgId, id);
  const doc = await User.findById(id).lean<UserDoc & { _id: Types.ObjectId }>();
  if (!doc) throw new NotFoundError("User not found");
  return toPublic(doc);
}

export async function createUser(
  input: CreateUserInput,
  ctx: MutationContext,
): Promise<PublicUser> {
  await connectMongo();
  ensureCanManageRole(ctx.actor, input.role);

  // orgId is required for new admin-provisioned users so the resulting
  // OrgMember row pins them to the inviting org. Without it the user
  // would exist but be unreachable from any tenant's team listing.
  if (!ctx.orgId) {
    throw new ValidationError("Active organization required to create a user");
  }

  const existing = await User.exists({ email: input.email.toLowerCase() });
  if (existing) {
    throw new ConflictError("A user with that email already exists");
  }

  const passwordHash = await hashPassword(input.password);
  const orgObjectId = new Types.ObjectId(ctx.orgId);
  const doc = await User.create({
    name: input.name,
    email: input.email.toLowerCase(),
    passwordHash,
    role: input.role,
    status: RecordState.ACTIVE,
    createdBy: new Types.ObjectId(ctx.actor.id),
    primaryOrgId: orgObjectId,
  });

  // Pin the new user into the inviting org so the team listing (now
  // scoped via OrgMember) actually shows them.
  await OrgMember.create({
    orgId: orgObjectId,
    userId: doc._id,
    role: input.role,
    status: RecordState.ACTIVE,
    invitedBy: new Types.ObjectId(ctx.actor.id),
    joinedAt: new Date(),
  });

  await recordAudit({
    action: AuditAction.USER_CREATED,
    entityType: AuditEntity.USER,
    entityId: String(doc._id),
    actor: { userId: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
    request: ctx.request ?? null,
    metadata: { email: doc.email, role: doc.role },
  });

  publishEvent({
    type: DomainEventType.USER_CREATED,
    audience: { kind: "admins" },
    actor: { id: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
    // Scope the SSE delivery to the creating tenant — admins in
    // other orgs will not receive this user-creation notification.
    orgId: ctx.orgId ?? null,
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
  if (!ctx.orgId) {
    throw new ValidationError("Active organization required to update a user");
  }
  // Cross-tenant guard: same 404 a missing user gets so admins of org A
  // can't probe org B for user ids.
  await assertMember(ctx.orgId, id);
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
    orgId: ctx.orgId ?? null,
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
  if (!ctx.orgId) {
    throw new ValidationError(
      "Active organization required to reset a user's password",
    );
  }
  await assertMember(ctx.orgId, id);
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
