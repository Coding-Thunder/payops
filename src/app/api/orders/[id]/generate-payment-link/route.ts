import type { NextRequest } from "next/server";
import { z } from "zod";

import { PAYMENT_GATEWAY_KEYS } from "@/lib/constants/enums";
import { Permission } from "@/lib/constants/permissions";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { initiatePayment } from "@/server/services/order.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

const generatePaymentLinkSchema = z.object({
  gateway: z.enum(PAYMENT_GATEWAY_KEYS).optional(),
});

/**
 * POST /api/orders/[id]/generate-payment-link
 *
 * Step 3 of the linear agent flow: explicit "Generate Payment Link"
 * action from the email composer. Decouples payment-session creation
 * from order creation — the agent picks the gateway and clicks the
 * button when they're ready, not the moment the order is persisted.
 *
 * Idempotent: re-clicking returns the existing checkout URL.
 * The send-payment-request endpoint enforces that the link exists
 * before it'll dispatch the email.
 */
export const POST = withApi(async (req: NextRequest, { params }: Params) => {
  const actor = await requirePermission(Permission.ORDER_VIEW_OWN);
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const input = generatePaymentLinkSchema.parse(body);
  const reqCtx = await getRequestContext();
  const result = await initiatePayment(
    id,
    { actor, orgId: actor.orgId, request: reqCtx },
    { gateway: input.gateway },
  );
  return jsonOk(result);
});
