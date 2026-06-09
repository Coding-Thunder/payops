import { type ClientSession, Types } from "mongoose";

import {
  AuditAction,
  AuditEntity,
  UserRole,
} from "@/lib/constants/enums";
import { logger } from "@/lib/logger";
import { AuditLog } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import { sessionOpt } from "@/server/db/transaction";
import type { AuditLogDTO } from "@/types";

import type { RequestContext } from "@/server/api/request-context";

interface AuditActor {
  userId?: string | null;
  name?: string | null;
  email?: string | null;
  role?: UserRole | null;
}

interface RecordAuditInput {
  action: AuditAction;
  entityType: AuditEntity;
  entityId?: string | null;
  /** Active organization. Optional during the multi-tenant migration -
   *  callers that haven't been org-aware-ified yet pass nothing, the
   *  row lands with `orgId: null`, and per-tenant audit views ignore
   *  it. New code paths (and refactors of touched code) MUST pass
   *  `orgId` so the audit trail is tenant-isolated end-to-end. */
  orgId?: string | null;
  actor?: AuditActor | null;
  request?: RequestContext | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Record an audit log entry.
 *
 * Two call shapes:
 *   - Default (no `session`): failures are swallowed and logged, used
 *     by best-effort audit hooks (e.g. login failures) that must never
 *     block the caller.
 *   - With `session`: the audit row joins the caller's mongoose
 *     transaction. Failures BUBBLE so the transaction can roll back
 *     atomically. This is the dispute-grade path used by webhook +
 *     order-create flows.
 */
export async function recordAudit(
  input: RecordAuditInput,
  session: ClientSession | null = null,
): Promise<void> {
  if (session) {
    await connectMongo();
    await AuditLog.create([buildDoc(input)], sessionOpt(session));
    return;
  }
  try {
    await connectMongo();
    await AuditLog.create(buildDoc(input));
  } catch (err) {
    logger.error("audit.record_failed", {
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? undefined,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

function buildDoc(input: RecordAuditInput) {
  return {
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    orgId:
      input.orgId && Types.ObjectId.isValid(input.orgId)
        ? new Types.ObjectId(input.orgId)
        : null,
    actor: {
      userId: input.actor?.userId
        ? new Types.ObjectId(input.actor.userId)
        : null,
      name: input.actor?.name ?? null,
      email: input.actor?.email ?? null,
      role: input.actor?.role ?? null,
    },
    request: {
      ip: input.request?.ip ?? null,
      userAgent: input.request?.userAgent ?? null,
      requestId: input.request?.requestId ?? null,
    },
    metadata: input.metadata ?? null,
  };
}

interface ListAuditQuery {
  entityType?: AuditEntity;
  entityId?: string;
  action?: AuditAction;
  page?: number;
  pageSize?: number;
  /** Active org. When supplied, the filter pins on `orgId` strictly -
   *  the legacy null-orgId fallback was retired in Phase 3d once the
   *  Phase-0/1 migration backfilled every audit row. Cross-tenant
   *  admin views (platform-side analytics) bypass this by omitting
   *  the field, and should add a `// SCOPE_OK:` comment so reviewers
   *  see the intent. */
  orgId?: string | null;
}

interface DeleteAuditActor {
  id: string;
  name: string;
  email: string;
  role: UserRole;
}

interface DeleteAuditContext {
  actor: DeleteAuditActor;
  /** Active org. Required: deletion by raw _id without orgId scoping
   *  would let an AUDIT_DELETE admin in org A purge another tenant's
   *  audit trail by guessing ids. */
  orgId: string;
  request?: RequestContext | null;
}

/**
 * Hard-deletes audit log entries by id, scoped to the actor's org.
 * Records its own audit row capturing which entries were purged so
 * the deletion itself is traceable.
 */
export async function deleteAuditLogs(
  ids: string[],
  ctx: DeleteAuditContext,
): Promise<{ deleted: number }> {
  await connectMongo();
  const valid = ids.filter((id) => Types.ObjectId.isValid(id));
  if (valid.length === 0) return { deleted: 0 };
  const objectIds = valid.map((id) => new Types.ObjectId(id));
  const res = await AuditLog.deleteMany({
    _id: { $in: objectIds },
    orgId: new Types.ObjectId(ctx.orgId),
  });

  await recordAudit({
    action: AuditAction.AUDIT_LOG_DELETED,
    entityType: AuditEntity.SYSTEM,
    entityId: null,
    actor: { userId: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
    request: ctx.request ?? null,
    metadata: { deletedCount: res.deletedCount ?? 0, ids: valid },
  });

  return { deleted: res.deletedCount ?? 0 };
}

export async function listAuditLogs(query: ListAuditQuery = {}) {
  await connectMongo();
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 50));
  const filter: Record<string, unknown> = {};
  if (query.entityType) filter.entityType = query.entityType;
  if (query.entityId) filter.entityId = query.entityId;
  if (query.action) filter.action = query.action;
  if (query.orgId && Types.ObjectId.isValid(query.orgId)) {
    // Strict per-org filter. Tenants only see their own audit trail.
    // Migration script backfilled orgId onto every legacy row in
    // Phase 0+1, so there should be no null-orgId rows left. If any
    // slip through, they're invisible to per-org admin views, which
    // is the desired security posture going forward.
    filter.orgId = new Types.ObjectId(query.orgId);
  }

  const [items, total] = await Promise.all([
    AuditLog.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    AuditLog.countDocuments(filter),
  ]);

  const mapped: AuditLogDTO[] = items.map((i) => ({
    id: String(i._id),
    action: i.action as AuditAction,
    entityType: i.entityType as AuditEntity,
    entityId: i.entityId ?? null,
    actorId: i.actor?.userId ? String(i.actor.userId) : null,
    actorName: i.actor?.name ?? null,
    actorRole: (i.actor?.role as UserRole | null) ?? null,
    ip: i.request?.ip ?? null,
    userAgent: i.request?.userAgent ?? null,
    metadata: i.metadata ?? null,
    createdAt: i.createdAt.toISOString(),
  }));

  return { items: mapped, total, page, pageSize };
}
