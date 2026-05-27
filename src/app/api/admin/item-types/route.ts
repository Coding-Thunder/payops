import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { createItemTypeSchema } from "@/lib/validation";
import { requireOrgId } from "@/server/db/org/org-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import {
  createItemType,
  listAllItemTypes,
} from "@/server/services/item-type.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Admin list — includes ARCHIVED rows so admins can restore or audit.
 * Public-ish list (active only) is served by `/api/item-types`.
 */
export const GET = withApi(async (_req: NextRequest) => {
  const actor = await requirePermission(Permission.ITEM_TYPE_MANAGE);
  const orgId = requireOrgId(actor.orgId);
  const items = await listAllItemTypes({ orgId, actorId: actor.id });
  return jsonOk({ items });
});

export const POST = withApi(async (req: NextRequest) => {
  const actor = await requirePermission(Permission.ITEM_TYPE_MANAGE);
  const orgId = requireOrgId(actor.orgId);
  const body = await req.json();
  const input = createItemTypeSchema.parse(body);
  const created = await createItemType(input, { orgId, actorId: actor.id });
  return jsonOk(created, { status: 201 });
});
