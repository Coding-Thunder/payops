import type { NextRequest } from "next/server";

import { ForbiddenError } from "@/lib/errors";
import { Permission } from "@/lib/constants/permissions";
import { analyticsQuerySchema } from "@/lib/validation";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { getAnalyticsSummary } from "@/server/services/analytics.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi(async (req: NextRequest) => {
  const actor = await requirePermission(Permission.ANALYTICS_VIEW);
  // Tenant scope: pin to the caller's org. Without this the service's
  // no-orgId path aggregates across EVERY tenant (cross-tenant leak). The
  // analytics page already passes orgId; this route must too.
  if (!actor.orgId) throw new ForbiddenError("Active organization required");
  const url = new URL(req.url);
  const query = analyticsQuerySchema.parse(
    Object.fromEntries(url.searchParams.entries()),
  );
  const data = await getAnalyticsSummary(
    {
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
    },
    { orgId: actor.orgId },
  );
  return jsonOk(data);
});
