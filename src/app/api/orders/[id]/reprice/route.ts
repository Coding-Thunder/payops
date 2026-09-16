import { type NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { repriceOrderSchema } from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { repriceOrder } from "@/server/services/order.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * Change what an existing order collects, keeping the same order id.
 *
 * Authorization is enforced here AND again in the service: the route gate is
 * the coarse one, and the service re-checks because it is also reachable
 * from tests and any future caller.
 *
 * Rate-limited because it supersedes a gateway session as a side effect —
 * a hot loop here would churn checkout sessions at the provider.
 */
export const POST = withApi(
  async (req: NextRequest, { params }: Params) => {
    const actor = await requirePermission(Permission.ORDER_UPDATE);
    const { id } = await params;
    const body = repriceOrderSchema.parse(await req.json());
    const ctx = await getRequestContext();

    const order = await repriceOrder(id, body, { actor, request: ctx });
    return jsonOk({ order });
  },
  { rateLimit: { route: "order-reprice", max: 20, windowMs: 60_000 } },
);
