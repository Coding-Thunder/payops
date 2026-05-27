import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { gatewayKeyParamSchema } from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { disableGatewayCredential } from "@/server/payments/gateway-credentials.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ gateway: string }>;
}

/**
 * DELETE — flip `enabled: false` on the per-org credential row.
 *
 * We deliberately don't hard-delete: a future re-enable should
 * re-encrypt + re-save, not silently reuse a row that might have
 * stale credentials. Operators rotating to a new key go through
 * POST (which overwrites) rather than DELETE → POST.
 *
 * Removing the row entirely would also lose the audit history of
 * who-configured-what-when; the soft-disable keeps the trail.
 */
export const DELETE = withApi(
  async (_req: NextRequest, { params }: Params) => {
    const actor = await requirePermission(Permission.GATEWAY_MANAGE);
    if (!actor.orgId) {
      throw new Error("Your account is not attached to an organization.");
    }
    const { gateway } = gatewayKeyParamSchema.parse(await params);
    const ctx = await getRequestContext();
    await disableGatewayCredential(gateway, {
      actor: { id: actor.id, name: actor.name, role: actor.role },
      orgId: actor.orgId,
      request: ctx,
    });
    return jsonOk({ disabled: true, gateway });
  },
);
