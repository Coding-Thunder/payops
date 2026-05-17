import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { analyticsQuerySchema } from "@/lib/validation";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { getAnalyticsSummary } from "@/server/services/analytics.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi(async (req: NextRequest) => {
  await requirePermission(Permission.ANALYTICS_VIEW);
  const url = new URL(req.url);
  const query = analyticsQuerySchema.parse(
    Object.fromEntries(url.searchParams.entries()),
  );
  const data = await getAnalyticsSummary({
    from: query.from ? new Date(query.from) : undefined,
    to: query.to ? new Date(query.to) : undefined,
  });
  return jsonOk(data);
});
