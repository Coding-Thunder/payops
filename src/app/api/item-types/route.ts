import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { listActiveItemTypes } from "@/server/services/item-type.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Pass 5e — Per-tenant active ItemType catalog.
 *
 * The dynamic create-order form reads this once on mount to build the
 * "what kind of order is this?" picker + the per-attribute renderer.
 * Scoped by the actor's orgId (refused if the JWT is missing one) so a
 * cross-tenant id-guess can never list another org's catalog.
 */
export const GET = withApi(async (_req: NextRequest) => {
  const actor = await requirePermission(Permission.ITEM_TYPE_VIEW);
  const items = await listActiveItemTypes(actor.orgId ?? null);
  return jsonOk({ items });
});
