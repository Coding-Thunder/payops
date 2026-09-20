import { type NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { assertPaidFeaturesEnabled } from "@/lib/paid-features";
import { switchGatewaySchema } from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { switchOrderGateway } from "@/server/services/order.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * Issue a payment link on a DIFFERENT gateway for the same order — the
 * "Stripe declined, try PayPal" path.
 *
 * Rate-limited: each call opens a real checkout session at a provider, so a
 * hot loop here would churn sessions upstream.
 */
export const POST = withApi(
  async (req: NextRequest, { params }: Params) => {
    const actor = await requirePermission(Permission.ORDER_UPDATE);
    // A paid feature, switched off until paid for: see src/lib/paid-features.ts.
    assertPaidFeaturesEnabled();
    const { id } = await params;
    const body = switchGatewaySchema.parse(await req.json());
    const ctx = await getRequestContext();

    const result = await switchOrderGateway(id, body, { actor, request: ctx });
    return jsonOk(result);
  },
  { rateLimit: { route: "order-switch-gateway", max: 10, windowMs: 60_000 } },
);
