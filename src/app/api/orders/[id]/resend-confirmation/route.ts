import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { resendConfirmationEmail } from "@/server/services/order.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/orders/[id]/resend-confirmation — re-send the confirmation email
 * for a PAID order. Used after an agent pastes the supplier confirmation
 * number (the automatic send fires on payment, before that number exists).
 * Gated on ORDER_VIEW_OWN; the service enforces order ownership + PAID-only.
 */
export const POST = withApi(async (_req: NextRequest, { params }: Params) => {
  const actor = await requirePermission(Permission.ORDER_VIEW_OWN);
  const { id } = await params;
  const ctx = await getRequestContext();
  const data = await resendConfirmationEmail(id, { actor, request: ctx });
  return jsonOk(data);
});
