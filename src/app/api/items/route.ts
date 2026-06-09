import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { listItemsQuerySchema } from "@/lib/validation";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { listActiveItems } from "@/server/services/item.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Pass 6c, per-tenant active Item catalog.
 *
 * The create-order dynamic form reads this to power the "Pick from
 * catalog" affordance. Scoped to the actor's orgId (refused if the
 * JWT is missing one) so a cross-tenant id-guess can never list
 * another org's catalog.
 *
 * Optional `?itemTypeKey=…` filter narrows to a single vertical, so
 * the picker only shows items relevant to the line type the operator
 * is adding.
 */
export const GET = withApi(async (req: NextRequest) => {
  const actor = await requirePermission(Permission.ITEM_VIEW);
  const url = new URL(req.url);
  const query = listItemsQuerySchema.parse({
    itemTypeKey: url.searchParams.get("itemTypeKey") ?? undefined,
  });
  const items = await listActiveItems(actor.orgId ?? null, {
    itemTypeKey: query.itemTypeKey,
  });
  return jsonOk({ items });
});
