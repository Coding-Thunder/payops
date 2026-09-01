import type { NextRequest } from "next/server";

import { ServiceType } from "@/lib/constants/enums";
import { Permission } from "@/lib/constants/permissions";
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
  // A payload with no `serviceType` predates multi-service and is a car
  // rental — the only thing that existed then. Defaulting HERE rather than
  // in the schema keeps the union discriminated, which is what gives a
  // flight payload flight error messages instead of "invalid discriminator".
  const withService =
    body && typeof body === "object" && !Array.isArray(body)
      ? { serviceType: ServiceType.CAR_RENTAL, ...body }
      : body;
  const input = createOrderRequestSchema.parse(withService);
  const ctx = await getRequestContext();
  // The organization's own allow-list is enforced inside `createOrder`,
  // alongside the provider check — one place, on the write path, so no
  // route can forget it.
  const result = await createOrder(input, { actor, request: ctx });
  return jsonOk(result, { status: 201 });
});
