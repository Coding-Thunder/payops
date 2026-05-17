import { NextRequest } from "next/server";
import { z } from "zod";

import {
  AuditAction,
  AuditEntity,
} from "@/lib/constants/enums";
import { Permission } from "@/lib/constants/permissions";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { listAuditLogs } from "@/server/services/audit.service";

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
  await requirePermission(Permission.AUDIT_VIEW);
  const url = new URL(req.url);
  const query = querySchema.parse(
    Object.fromEntries(url.searchParams.entries()),
  );
  const data = await listAuditLogs({
    entityType: query.entityType as AuditEntity | undefined,
    entityId: query.entityId,
    action: query.action as AuditAction | undefined,
    page: query.page,
    pageSize: query.pageSize,
  });
  return jsonOk(data);
});
