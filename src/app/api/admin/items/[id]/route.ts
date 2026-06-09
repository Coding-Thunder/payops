import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { itemStatusSchema, updateItemSchema } from "@/lib/validation";
import { RecordState } from "@/lib/constants/enums";
import { requireOrgId } from "@/server/db/org/org-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import {
  archiveItem,
  getItemById,
  restoreItem,
  updateItem,
} from "@/server/services/item.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export const GET = withApi(
  async (_req: NextRequest, { params }: RouteParams) => {
    const actor = await requirePermission(Permission.ITEM_MANAGE);
    const orgId = requireOrgId(actor.orgId);
    const { id } = await params;
    const data = await getItemById(id, {
      orgId,
      actorId: actor.id,
      actorName: actor.name,
    });
    return jsonOk(data);
  },
);

export const PATCH = withApi(
  async (req: NextRequest, { params }: RouteParams) => {
    const actor = await requirePermission(Permission.ITEM_MANAGE);
    const orgId = requireOrgId(actor.orgId);
    const { id } = await params;
    const body = await req.json();
    const ctx = {
      orgId,
      actorId: actor.id,
      actorName: actor.name,
    };
    // Status-only PATCH = archive/restore. Other PATCHes treat the
    // body as a field-update payload.
    if (
      body &&
      typeof body === "object" &&
      "status" in body &&
      Object.keys(body).length === 1
    ) {
      const { status } = itemStatusSchema.parse(body);
      const data =
        status === RecordState.ACTIVE
          ? await restoreItem(id, ctx)
          : await archiveItem(id, ctx);
      return jsonOk(data);
    }
    const input = updateItemSchema.parse(body);
    const data = await updateItem(id, input, ctx);
    return jsonOk(data);
  },
);
