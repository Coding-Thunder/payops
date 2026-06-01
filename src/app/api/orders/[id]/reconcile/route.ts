import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { reconcileOrderPayment } from "@/server/services/order.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/orders/[id]/reconcile
 *
 * Asks Stripe directly whether the customer has paid this session.
 * Drives the same atomic PAID transition the webhook uses when Stripe
 * says yes, backstops dropped / delayed webhooks and the local-dev
 * "stripe listen isn't running" case.
 *
 * Authorized as ORDER_VIEW_OWN (staff can reconcile orders they
 * created); the service layer enforces the ownership check beyond that.
 */
export const POST = withApi(
  async (_req: NextRequest, { params }: Params) => {
    const actor = await requirePermission(Permission.ORDER_VIEW_OWN);
    const { id } = await params;
    const reqCtx = await getRequestContext();
    const result = await reconcileOrderPayment(id, {
      actor,
      orgId: actor.orgId,
      request: reqCtx,
    });
    return jsonOk(result);
  },
  {
    // Each call hits Stripe's API, cap so a polling client (or a
    // misbehaving tab) can't burn the merchant's Stripe rate budget.
    rateLimit: { route: "order-reconcile", max: 30, windowMs: 60_000 },
  },
);
