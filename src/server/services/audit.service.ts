import { Types } from "mongoose";

import {
  AuditAction,
  AuditEntity,
  UserRole,
} from "@/lib/constants/enums";
import { logger } from "@/lib/logger";
import { AuditLog } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
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
}

/**
 * Records an audit log entry. Failures are swallowed and logged - audit
 * persistence must never block the primary operation.
 */
export async function recordAudit(input: RecordAuditInput): Promise<void> {
  try {
    await connectMongo();
    await AuditLog.create({
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
    });
  } catch (err) {
    logger.error("audit.record_failed", {
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? undefined,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

interface ListAuditQuery {
  entityType?: AuditEntity;
  entityId?: string;
  action?: AuditAction;
  page?: number;
  pageSize?: number;
}

export async function listAuditLogs(query: ListAuditQuery = {}) {
  await connectMongo();
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 50));
  const filter: Record<string, unknown> = {};
  if (query.entityType) filter.entityType = query.entityType;
  if (query.entityId) filter.entityId = query.entityId;
  if (query.action) filter.action = query.action;

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
