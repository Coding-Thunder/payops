import { Permission } from "@/lib/constants/permissions";
import { assertPaidFeaturesEnabled } from "@/lib/paid-features";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { getOrderGatewayOptions } from "@/server/services/order.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * Which gateways this order could be moved to.
 *
 * Read from the order's OWN organization rather than a global list, so an
 * operator is never offered a provider this brand has not enabled — the
 * switch would refuse it server-side anyway, and offering it would be a
 * dead control.
 */
export const GET = withApi(async (_req, { params }: Params) => {
  await requirePermission(Permission.ORDER_UPDATE);
  // A paid feature, switched off until paid for: see src/lib/paid-features.ts.
  assertPaidFeaturesEnabled();
  const { id } = await params;
  return jsonOk(await getOrderGatewayOptions(id));
});
