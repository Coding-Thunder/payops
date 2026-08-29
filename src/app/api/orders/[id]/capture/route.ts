import type { NextRequest } from "next/server";
import { z } from "zod";

import { Permission } from "@/lib/constants/permissions";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { capturePayment } from "@/server/services/payment-capture.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

const captureBodySchema = z.object({
  /** Major units. Omitted = capture the full authorized amount. */
  amount: z.number().positive().max(1_000_000).optional().nullable(),
});

/**
 * POST /api/orders/[id]/capture
 *
 * Converts an AUTHORIZED hold into a real charge. The operator calls this
 * once the booking is confirmed with the supplier.
 *
 * Gated on ORDER_CAPTURE_PAYMENT, which is ADMIN and above — deliberately
 * not STAFF. The service layer additionally refuses any order that is not
 * manual-capture, so this route is inert for the automatic-capture brands.
 */
export const POST = withApi(
  async (req: NextRequest, { params }: Params) => {
    const actor = await requirePermission(Permission.ORDER_CAPTURE_PAYMENT);
    const { id } = await params;
    // A capture with no body is the common case (full amount).
    const raw = await req.json().catch(() => ({}));
    const body = captureBodySchema.parse(raw ?? {});
    const reqCtx = await getRequestContext();
    const order = await capturePayment(
      id,
      { actor, request: reqCtx },
      { amount: body.amount ?? null },
    );
    return jsonOk({ order });
  },
  {
    // Every call reaches Stripe and moves money. Capped tightly — the
    // service layer's CAPTURE_PENDING claim already prevents a double
    // charge, but there is no reason for a client to call this in a loop.
    rateLimit: { route: "order-capture", max: 10, windowMs: 60_000 },
  },
);
