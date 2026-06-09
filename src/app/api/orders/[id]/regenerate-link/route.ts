import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { regeneratePaymentLink } from "@/server/services/order.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

export const POST = withApi(async (_req: NextRequest, { params }: Params) => {
  const actor = await requirePermission(Permission.ORDER_REGENERATE_LINK);
  const { id } = await params;
  const ctx = await getRequestContext();
  const result = await regeneratePaymentLink(id, {
    actor,
    orgId: actor.orgId,
    request: ctx,
  });
  return jsonOk(result);
});
