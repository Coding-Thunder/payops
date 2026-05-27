import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import {
  createOrderUniversalSchema,
  listOrdersQuerySchema,
} from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { createOrder, listOrders } from "@/server/services/order.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi(async (req: NextRequest) => {
  const actor = await requirePermission(Permission.ORDER_VIEW_OWN);
  const url = new URL(req.url);
  const query = listOrdersQuerySchema.parse(
    Object.fromEntries(url.searchParams.entries()),
  );
  const data = await listOrders(query, { actor, orgId: actor.orgId });
  return jsonOk(data);
});

/**
 * Universal commerce shape only: `lineItems[]` + optional `scheduling`.
 * Pass 5h removed the legacy rental discriminator.
 */
export const POST = withApi(async (req: NextRequest) => {
  const actor = await requirePermission(Permission.ORDER_CREATE);
  const body = await req.json();
  const ctx = await getRequestContext();
  const parsed = createOrderUniversalSchema.parse(body);
  const result = await createOrder(parsed, {
    actor,
    orgId: actor.orgId,
    request: ctx,
  });
  return jsonOk(result, { status: 201 });
});
