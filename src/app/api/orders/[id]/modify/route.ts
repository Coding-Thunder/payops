import { type NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { modifyOrderSchema } from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { applyOrderModification } from "@/server/services/order.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * MCO — apply a customer-requested change to an existing booking.
 *
 * Amends the order in place; never creates one. The response returns the
 * field-level diff so the operator UI can show exactly what moved, and
 * `amountChanged` so it can say whether a new payment link is needed.
 */
export const POST = withApi(
  async (req: NextRequest, { params }: Params) => {
    const actor = await requirePermission(Permission.ORDER_UPDATE);
    const { id } = await params;
    const body = modifyOrderSchema.parse(await req.json());
    const ctx = await getRequestContext();

    const result = await applyOrderModification(id, body, {
      actor,
      request: ctx,
    });
    return jsonOk(result);
  },
  { rateLimit: { route: "order-modify", max: 30, windowMs: 60_000 } },
);
