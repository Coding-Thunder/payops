import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { confirmationNumberSchema } from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { setConfirmationNumber } from "@/server/services/order.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/orders/[id]/confirmation-number — staff paste the supplier
 * confirmation number. Gated on ORDER_VIEW_OWN (which STAFF hold); the
 * service enforces order ownership so a STAFF user can only edit their own
 * orders, while admins (ORDER_VIEW_ALL) can edit any. Empty string clears it.
 */
export const POST = withApi(async (req: NextRequest, { params }: Params) => {
  const actor = await requirePermission(Permission.ORDER_VIEW_OWN);
  const { id } = await params;
  const body = await req.json();
  const input = confirmationNumberSchema.parse(body);
  const ctx = await getRequestContext();
  const data = await setConfirmationNumber(id, input.confirmationNumber, {
    actor,
    request: ctx,
  });
  return jsonOk(data);
});
