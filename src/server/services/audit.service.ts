import { type ClientSession, Types } from "mongoose";

import {
  AuditAction,
  AuditEntity,
  UserRole,
} from "@/lib/constants/enums";
import { logger } from "@/lib/logger";
import { AuditLog } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import {
  organizationStamp,
  withOrganizationScope,
} from "@/server/db/organization-filter";
import { getRequestOrganizationScope } from "@/server/auth/organization";
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
  actor?: AuditActor | null;
  request?: RequestContext | null;
  metadata?: Record<string, unknown> | null;
  /**
   * Explicit tenant attribution, for callers that have no request context.
   *
   * Webhook and outbox paths run with no cookie and no session, so the
   * ambient scope resolves to null — and a null-organization audit row is
   * visible ONLY to the default organization. That was invisible while the
   * default organization was also the only one taking Stripe payments; with
   * a third tenant it means a brand cannot see its own payment audit trail.
   *
   * OPTIONAL and undefined by default, so every existing caller keeps the
   * exact attribution it had.
   */
  organizationId?: string | Types.ObjectId | null;
}

/**
 * Record an audit log entry.
 *
 * Two call shapes:
 *   - Default (no `session`): failures are swallowed and logged — used
 *     by best-effort audit hooks (e.g. login failures) that must never
 *     block the caller.
 *   - With `session`: the audit row joins the caller's mongoose
 *     transaction. Failures BUBBLE so the transaction can roll back
 *     atomically. This is the dispute-grade path used by webhook +
 *     order-create flows.
 */
function toObjectIdOrNull(
  value: string | Types.ObjectId | null | undefined,
): Types.ObjectId | null {
  if (!value) return null;
  if (value instanceof Types.ObjectId) return value;
  return Types.ObjectId.isValid(value) ? new Types.ObjectId(value) : null;
}

export async function recordAudit(
  input: RecordAuditInput,
  session: ClientSession | null = null,
): Promise<void> {
  // Attribute the row to the acting organization. Null on webhook, outbox
  // and script paths, which have no organization context and never should —
  // matching how those rows looked before the migration.
  const organizationId =
    input.organizationId !== undefined
      ? toObjectIdOrNull(input.organizationId)
      : organizationStamp(await getRequestOrganizationScope());

  if (session) {
    await connectMongo();
    await AuditLog.create(
      [{ ...buildDoc(input), organizationId }],
      sessionOpt(session),
    );
    return;
  }
  try {
    await connectMongo();
    await AuditLog.create({ ...buildDoc(input), organizationId });
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
}

interface DeleteAuditActor {
  id: string;
  name: string;
  email: string;
  role: UserRole;
}

interface DeleteAuditContext {
  actor: DeleteAuditActor;
  request?: RequestContext | null;
}

/**
 * Hard-deletes audit log entries by id. Records its own audit row capturing
 * which entries were purged so the deletion itself is traceable.
 */
export async function deleteAuditLogs(
  ids: string[],
  ctx: DeleteAuditContext,
): Promise<{ deleted: number }> {
  await connectMongo();
  const valid = ids.filter((id) => Types.ObjectId.isValid(id));
  if (valid.length === 0) return { deleted: 0 };
  const objectIds = valid.map((id) => new Types.ObjectId(id));
  const res = await AuditLog.deleteMany({ _id: { $in: objectIds } });

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
  const base: Record<string, unknown> = {};
  if (query.entityType) base.entityType = query.entityType;
  if (query.entityId) base.entityId = query.entityId;
  if (query.action) base.action = query.action;

  // The audit log is the record of who did what. Unscoped, this hands one
  // organization a readable feed of another's operators, customers and
  // order numbers.
  const filter = withOrganizationScope(
    base,
    await getRequestOrganizationScope(),
  );

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
