import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { createItemSchema, listItemsQuerySchema } from "@/lib/validation";
import { requireOrgId } from "@/server/db/org/org-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import {
  createItem,
  listAllItems,
} from "@/server/services/item.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Admin list — includes ARCHIVED + DISABLED so admins can audit the
 * full catalog history. Public-ish active-only list is at `/api/items`.
 */
export const GET = withApi(async (req: NextRequest) => {
  const actor = await requirePermission(Permission.ITEM_MANAGE);
  const orgId = requireOrgId(actor.orgId);
  const url = new URL(req.url);
  const query = listItemsQuerySchema.parse({
    itemTypeKey: url.searchParams.get("itemTypeKey") ?? undefined,
  });
  const items = await listAllItems(
    { orgId, actorId: actor.id, actorName: actor.name },
    { itemTypeKey: query.itemTypeKey },
  );
  return jsonOk({ items });
});

export const POST = withApi(async (req: NextRequest) => {
  const actor = await requirePermission(Permission.ITEM_MANAGE);
  const orgId = requireOrgId(actor.orgId);
  const body = await req.json();
  const input = createItemSchema.parse(body);
  const created = await createItem(input, {
    orgId,
    actorId: actor.id,
    actorName: actor.name,
  });
  return jsonOk(created, { status: 201 });
});
