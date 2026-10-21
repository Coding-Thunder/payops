import { NextRequest } from "next/server";
import { z } from "zod";

import {
  AuditAction,
  AuditEntity,
} from "@/lib/constants/enums";
import { ForbiddenError } from "@/lib/errors";
import { Permission } from "@/lib/constants/permissions";
import { deleteByIdsSchema } from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import {
  deleteAuditLogs,
  listAuditLogs,
} from "@/server/services/audit.service";

const querySchema = z.object({
  entityType: z.enum(Object.values(AuditEntity) as [string, ...string[]]).optional(),
  entityId: z.string().optional(),
  action: z.enum(Object.values(AuditAction) as [string, ...string[]]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi(async (req: NextRequest) => {
  const actor = await requirePermission(Permission.AUDIT_VIEW);
  // The same guard DELETE has, and for the same reason. `listAuditLogs` only
  // applies its org filter when `orgId` is truthy, so passing null does not
  // narrow the query — it REMOVES the tenant boundary and returns every
  // tenant's audit trail. A user with no active organization is exactly the
  // case the permission check cannot catch, because AUDIT_VIEW says what they
  // may read, not whose.
  if (!actor.orgId) throw new ForbiddenError("Active organization required");
  const url = new URL(req.url);
  const query = querySchema.parse(
    Object.fromEntries(url.searchParams.entries()),
  );
  // Strict per-org filter, Phase 3d retired the legacy null-orgId
  // fallback. Each tenant sees only their own audit trail.
  const data = await listAuditLogs({
    entityType: query.entityType as AuditEntity | undefined,
    entityId: query.entityId,
    action: query.action as AuditAction | undefined,
    page: query.page,
    pageSize: query.pageSize,
    orgId: actor.orgId,
  });
  return jsonOk(data);
});

export const DELETE = withApi(async (req: NextRequest) => {
  const actor = await requirePermission(Permission.AUDIT_DELETE);
  if (!actor.orgId) throw new ForbiddenError("Active organization required");
  const body = await req.json().catch(() => ({}));
  const { ids } = deleteByIdsSchema.parse(body);
  const ctx = await getRequestContext();
  const result = await deleteAuditLogs(ids, {
    actor,
    orgId: actor.orgId,
    request: ctx,
  });
  return jsonOk(result);
});
