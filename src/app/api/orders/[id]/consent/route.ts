import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { listConsentsForOrder } from "@/server/services/consent.service";
import { getOrderById } from "@/server/services/order.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/orders/[id]/consent — full audit trail of consent records
 * attached to this order. The Order DTO already carries a denormalised
 * pointer; this endpoint exists for the order-detail timeline / admin
 * view where multiple historical records matter.
 *
 * There is no POST here any more — the only path to record consent is
 * the customer-facing hosted page (POST /api/consent/[token]), which
 * captures a signed name + IP + UA and auto-promotes to VERIFIED.
 */
export const GET = withApi(async (_req: NextRequest, { params }: Params) => {
  const actor = await requirePermission(Permission.CONSENT_VIEW);
  const { id } = await params;
  // Order existence + access check goes through the same path as the
  // detail page so RBAC stays uniform.
  await getOrderById(id, { actor });
  const items = await listConsentsForOrder(id, { actor });
  return jsonOk({ items });
});
