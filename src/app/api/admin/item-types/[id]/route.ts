import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import {
  itemTypeStatusSchema,
  updateItemTypeSchema,
} from "@/lib/validation";
import { RecordState } from "@/lib/constants/enums";
import { requireOrgId } from "@/server/db/org/org-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import {
  archiveItemType,
  getItemTypeById,
  restoreItemType,
  updateItemType,
} from "@/server/services/item-type.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export const GET = withApi(async (_req: NextRequest, { params }: RouteParams) => {
  const actor = await requirePermission(Permission.ITEM_TYPE_MANAGE);
  const orgId = requireOrgId(actor.orgId);
  const { id } = await params;
  const data = await getItemTypeById(id, { orgId, actorId: actor.id });
  return jsonOk(data);
});

export const PATCH = withApi(
  async (req: NextRequest, { params }: RouteParams) => {
    const actor = await requirePermission(Permission.ITEM_TYPE_MANAGE);
    const orgId = requireOrgId(actor.orgId);
    const { id } = await params;
    const body = await req.json();
    // Two payload shapes: a full field update OR a status-only flip
    // (archive/restore). Status-only is treated as a separate verb so
    // the admin UI can offer Archive/Restore buttons without re-sending
    // the whole attribute schema.
    if (body && typeof body === "object" && "status" in body && Object.keys(body).length === 1) {
      const { status } = itemTypeStatusSchema.parse(body);
      const data =
        status === RecordState.ACTIVE
          ? await restoreItemType(id, { orgId, actorId: actor.id })
          : await archiveItemType(id, { orgId, actorId: actor.id });
      return jsonOk(data);
    }
    const input = updateItemTypeSchema.parse(body);
    const data = await updateItemType(id, input, {
      orgId,
      actorId: actor.id,
    });
    return jsonOk(data);
  },
);
