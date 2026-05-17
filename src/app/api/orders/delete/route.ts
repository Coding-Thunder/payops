import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { deleteByIdsSchema } from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { deleteOrders } from "@/server/services/order.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Hard-deletes one or more orders. Single delete callers should pass an
 * `ids` array of length 1; the service rejects paid orders so the caller
 * can show which records were skipped.
 */
export const POST = withApi(async (req: NextRequest) => {
  const actor = await requirePermission(Permission.ORDER_DELETE);
  const body = await req.json().catch(() => ({}));
  const { ids } = deleteByIdsSchema.parse(body);
  const ctx = await getRequestContext();
  const result = await deleteOrders(ids, { actor, request: ctx });
  return jsonOk(result);
});
