import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { ServiceType } from "@/lib/constants/enums";
import {
  createOrderRequestSchema,
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
  const data = await listOrders(query, { actor });
  return jsonOk(data);
});

export const POST = withApi(async (req: NextRequest) => {
  const actor = await requirePermission(Permission.ORDER_CREATE);
  const body = await req.json();
  // Injecting the CAR_RENTAL default BEFORE parsing is what keeps every
  // pre-multi-service client working: the existing car-rental form posts no
  // `serviceType` at all, and with the default injected it validates through
  // the unchanged rental branch of the union. A payload that DOES carry a
  // serviceType overrides the default and is validated by its own branch.
  const input = createOrderRequestSchema.parse({
    serviceType: ServiceType.CAR_RENTAL,
    ...(body ?? {}),
  });
  const ctx = await getRequestContext();
  const result = await createOrder(input, { actor, request: ctx });
  return jsonOk(result, { status: 201 });
});
