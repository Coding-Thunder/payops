import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { listClients } from "@/server/services/client-profile.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Paginated, searchable list of Client Profiles for the active tenant. */
export const GET = withApi(async (req: NextRequest) => {
  const actor = await requirePermission(Permission.CUSTOMER_VIEW);
  const url = new URL(req.url);
  const result = await listClients(actor.orgId, {
    search: url.searchParams.get("q") ?? undefined,
    page: Number(url.searchParams.get("page")) || undefined,
    pageSize: Number(url.searchParams.get("pageSize")) || undefined,
    sort: url.searchParams.get("sort") ?? undefined,
  });
  return jsonOk(result);
});
