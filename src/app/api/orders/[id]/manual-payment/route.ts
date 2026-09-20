import { type NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { assertPaidFeaturesEnabled } from "@/lib/paid-features";
import { recordManualPaymentSchema } from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { recordManualPayment } from "@/server/services/order.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * Record a payment collected outside PayOps.
 *
 * The card is charged on an external terminal; this endpoint records only
 * the resulting confirmation. It accepts a method label and a reference and
 * nothing that could carry card data — the schema actively rejects a
 * reference shaped like a PAN.
 */
export const POST = withApi(
  async (req: NextRequest, { params }: Params) => {
    const actor = await requirePermission(Permission.ORDER_UPDATE);
    // A paid feature, switched off until paid for: see src/lib/paid-features.ts.
    assertPaidFeaturesEnabled();
    const { id } = await params;
    const body = recordManualPaymentSchema.parse(await req.json());
    const ctx = await getRequestContext();

    const order = await recordManualPayment(id, body, { actor, request: ctx });
    return jsonOk({ order });
  },
  { rateLimit: { route: "order-manual-payment", max: 10, windowMs: 60_000 } },
);
