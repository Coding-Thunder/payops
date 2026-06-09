import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { archiveOrderSchema } from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { archiveOrder, getOrderById } from "@/server/services/order.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

export const GET = withApi(async (_req: NextRequest, { params }: Params) => {
  const actor = await requirePermission(Permission.ORDER_VIEW_OWN);
  const { id } = await params;
  const data = await getOrderById(id, { actor, orgId: actor.orgId });
  return jsonOk(data);
});

export const DELETE = withApi(async (req: NextRequest, { params }: Params) => {
  const actor = await requirePermission(Permission.ORDER_ARCHIVE);
  const { id } = await params;
  const body = await safeJson(req);
  const input = archiveOrderSchema.parse(body ?? {});
  const ctx = await getRequestContext();
  const data = await archiveOrder(id, input, {
    actor,
    orgId: actor.orgId,
    request: ctx,
  });
  return jsonOk(data);
});

async function safeJson(req: NextRequest): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}
