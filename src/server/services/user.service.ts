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
  isMemberEligiblePermission,
  toWorkspaceRole,
  type MemberPermissionMode,
} from "@/lib/constants/permissions";
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
  UpdateMemberPermissionsInput,
  UpdateUserInput,
} from "@/lib/validation";
import { OrgMember, User, type UserDoc } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import type { PublicUser } from "@/types";

import type { RequestContext } from "@/server/api/request-context";
import { hashPassword } from "@/server/auth/password";
import { recordAudit } from "./audit.service";

/** The OrgMember fields the team surfaces need to render a member's
 *  workspace role + permission state. */
interface MembershipView {
  role: UserRole;
  permissionMode?: MemberPermissionMode;
  permissions?: string[];
}

function toPublic(
  doc: UserDoc & { _id: Types.ObjectId | string },
  membership?: MembershipView | null,
): PublicUser {
  const base: PublicUser = {
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
  if (membership) {
    // OrgMember.role is the authoritative per-workspace role the session
    // resolver reads — surface the two-role view + the persisted grant
    // state so the Team & Permissions editor can prefill accurately.
    base.workspaceRole = toWorkspaceRole(membership.role);
    base.permissionMode = membership.permissionMode ?? "full";
    base.permissions = membership.permissions ?? [];
  }
  return base;
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
 * Resolve the OrgMember rows for a given org. Membership is the source of
 * truth for the team boundary (admins of org A never see users from org B)
 * AND carries the per-member role + permission state the team surfaces
 * render. User.primaryOrgId is informative but not authoritative.
 */
async function membershipsForOrg(
  orgId: string,
): Promise<Array<{ userId: Types.ObjectId } & MembershipView>> {
  return OrgMember.find({
    orgId: new Types.ObjectId(orgId),
    status: { $ne: RecordState.ARCHIVED },
  })
    .select({ userId: 1, role: 1, permissionMode: 1, permissions: 1, _id: 0 })
    .lean<Array<{ userId: Types.ObjectId } & MembershipView>>();
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
  const memberships = await membershipsForOrg(ctx.orgId);
  // No members yet, short-circuit to an empty page so the rest of the
  // query never sees a filter that would match the global collection.
  if (memberships.length === 0) {
    return { items: [], total: 0, page: query.page, pageSize: query.pageSize };
  }
  const memberIds = memberships.map((m) => m.userId);
  const membershipByUserId = new Map(
    memberships.map((m) => [String(m.userId), m]),
  );

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
    items: items.map((u) =>
      toPublic(u, membershipByUserId.get(String(u._id)) ?? null),
    ),
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
  // Membership pin first, strangers get the same 404 a missing user
  // gets, so an admin of org A can't enumerate ids that belong to org B.
  await assertMember(ctx.orgId, id);
  const doc = await User.findById(id).lean<UserDoc & { _id: Types.ObjectId }>();
  if (!doc) throw new NotFoundError("User not found");
  const membership = await OrgMember.findOne({
    orgId: new Types.ObjectId(ctx.orgId),
    userId: new Types.ObjectId(id),
    status: { $ne: RecordState.ARCHIVED },
  })
    .select({ role: 1, permissionMode: 1, permissions: 1, _id: 0 })
    .lean<MembershipView | null>();
  return toPublic(doc, membership);
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
    // Scope the SSE delivery to the creating tenant, admins in
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

/**
 * OWNER-only: set a MEMBER's permission model (Full vs Custom) and, for
 * Custom, the granted permission keys — writing the OrgMember row the
 * session guard reads. Defense-in-depth (any single failing layer still
 * fails safe):
 *   - the route actor gate (requireOwner) must run before this;
 *   - self-edit and owner-target are rejected here;
 *   - custom grants are intersected with the member-eligible allow-list, so
 *     a restricted/bogus key can never be persisted;
 *   - resolveEffectivePermissions re-filters on every subsequent request.
 *
 * The change takes effect on the member's NEXT request (getCurrentUser
 * re-reads the OrgMember row fresh) — no re-login required.
 */
export async function setMemberPermissions(
  userId: string,
  input: UpdateMemberPermissionsInput,
  ctx: MutationContext,
): Promise<PublicUser> {
  await connectMongo();
  if (!Types.ObjectId.isValid(userId)) throw new NotFoundError("User not found");
  if (!ctx.orgId) {
    throw new ValidationError(
      "Active organization required to change permissions",
    );
  }
  // An owner can't strip (or edit) their own access from here.
  if (ctx.actor.id === userId) {
    throw new ValidationError("You cannot change your own permissions");
  }
  // Cross-tenant guard: same 404 a missing user gets.
  await assertMember(ctx.orgId, userId);
  const member = await OrgMember.findOne({
    orgId: new Types.ObjectId(ctx.orgId),
    userId: new Types.ObjectId(userId),
    status: RecordState.ACTIVE,
  });
  if (!member) throw new NotFoundError("User not found");
  // Owners always have full workspace control — mirror the resolver
  // short-circuit so their row is never rewritten to a member shape.
  if (toWorkspaceRole(member.role) === "OWNER") {
    throw new ValidationError("Owners always have full workspace control");
  }

  const from = {
    permissionMode: member.permissionMode,
    permissions: member.permissions ?? [],
  };
  // Custom grants can ONLY ever be member-eligible keys. This intersection
  // is the hard gate: a restricted permission posted by a tampered client
  // is silently dropped and never touches the database.
  const sanitized =
    input.permissionMode === "custom"
      ? input.permissions.filter(isMemberEligiblePermission)
      : [];
  member.permissionMode = input.permissionMode;
  member.permissions = sanitized;
  await member.save();

  const to = { permissionMode: input.permissionMode, permissions: sanitized };

  await recordAudit({
    action: AuditAction.USER_PERMISSIONS_CHANGED,
    entityType: AuditEntity.USER,
    entityId: userId,
    actor: { userId: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
    request: ctx.request ?? null,
    metadata: { from, to },
  });

  publishEvent({
    type: DomainEventType.USER_UPDATED,
    audience: { kind: "admins" },
    actor: { id: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
    orgId: ctx.orgId ?? null,
    payload: { userId, changes: { permissions: to } },
  });

  const doc = await User.findById(userId).lean<UserDoc & { _id: Types.ObjectId }>();
  if (!doc) throw new NotFoundError("User not found");
  return toPublic(doc, {
    role: member.role,
    permissionMode: member.permissionMode,
    permissions: member.permissions,
  });
}

/**
 * Self-serve: the caller updates ONLY their own display name. Deliberately
 * self-scoped (userId is taken from the actor, never a request param) and
 * carries no role/status/org gate — there is no way to touch another user
 * or escalate. Email/role stay read-only (owned by the sign-in provider /
 * not self-editable). Reflects immediately because getCurrentUser reads
 * name fresh from Mongo each request.
 */
export async function updateOwnName(
  input: { name: string },
  ctx: { actor: UserActor; request?: RequestContext | null },
): Promise<PublicUser> {
  await connectMongo();
  const doc = await User.findById(ctx.actor.id);
  if (!doc) throw new NotFoundError("User not found");

  if (input.name !== doc.name) {
    doc.name = input.name;
    await doc.save();
    await recordAudit({
      action: AuditAction.USER_UPDATED,
      entityType: AuditEntity.USER,
      entityId: String(doc._id),
      actor: {
        userId: ctx.actor.id,
        name: input.name,
        role: ctx.actor.role,
      },
      request: ctx.request ?? null,
      metadata: { changes: { name: input.name }, self: true },
    });
  }

  return toPublic(doc.toObject() as UserDoc & { _id: Types.ObjectId });
}

export async function touchLastLogin(userId: string): Promise<void> {
  await connectMongo();
  if (!Types.ObjectId.isValid(userId)) return;
  await User.updateOne(
    { _id: new Types.ObjectId(userId) },
    { $set: { lastLoginAt: new Date() } },
  );
}
