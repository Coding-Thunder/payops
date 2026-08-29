import type { NextRequest } from "next/server";
import { z } from "zod";

import { Permission } from "@/lib/constants/permissions";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { cancelAuthorization } from "@/server/services/payment-capture.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

const cancelBodySchema = z.object({
  /** Free-text operator note, written into the audit + evidence trail. */
  reason: z.string().trim().max(200).optional().nullable(),
});

/**
 * POST /api/orders/[id]/cancel-authorization
 *
 * Releases an authorized hold without charging — the booking could not be
 * fulfilled. The customer's funds are freed rather than charged and then
 * refunded.
 *
 * Gated on ORDER_VOID_AUTHORIZATION (ADMIN and above). The service layer
 * refuses any order that is not manual-capture, and refuses outright once
 * the payment has been captured (a refund is the correct instrument then).
 */
export const POST = withApi(
  async (req: NextRequest, { params }: Params) => {
    const actor = await requirePermission(Permission.ORDER_VOID_AUTHORIZATION);
    const { id } = await params;
    const raw = await req.json().catch(() => ({}));
    const body = cancelBodySchema.parse(raw ?? {});
    const reqCtx = await getRequestContext();
    const order = await cancelAuthorization(
      id,
      { actor, request: reqCtx },
      { reason: body.reason ?? null },
    );
    return jsonOk({ order });
  },
  {
    rateLimit: { route: "order-cancel-authorization", max: 10, windowMs: 60_000 },
  },
);
