import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { flagOrderSchema } from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { setOrderRiskFlag } from "@/server/services/order.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/orders/:id/risk, toggles the at-risk / disputes flag on an
 * order. Admin/super-admin only.
 */
export const POST = withApi(async (req: NextRequest, { params }: Params) => {
  const actor = await requirePermission(Permission.ORDER_UPDATE);
  const { id } = await params;
  const body = await req.json();
  const input = flagOrderSchema.parse(body);
  const ctx = await getRequestContext();
  const data = await setOrderRiskFlag(id, input, { actor, request: ctx });
  return jsonOk(data);
});
