import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { setPaymentMappingSchema } from "@/lib/validation";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { setPaymentStatusMapping } from "@/server/services/workflow.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** PATCH /api/admin/workflow/payment-mapping, re-point the
 *  payment-success / payment-failure target status keys. These are
 *  what the Stripe webhook writes into when a checkout completes or
 *  fails, so renaming statuses without updating these would silently
 *  route payments to the wrong state. Service guards against pointing
 *  success at a non-paid status. */
export const PATCH = withApi(async (req: NextRequest) => {
  const actor = await requirePermission(Permission.WORKFLOW_MANAGE);
  if (!actor.orgId) {
    throw new Error("Your account is not attached to an organization.");
  }
  const input = setPaymentMappingSchema.parse(await req.json());
  const workflow = await setPaymentStatusMapping(actor.orgId, input, {
    id: actor.id,
  });
  return jsonOk({ workflow });
});
