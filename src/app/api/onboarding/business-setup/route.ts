import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { completeBusinessSetupSchema } from "@/lib/validation";
import { requireOrgId } from "@/server/db/org/org-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { completeBusinessSetup } from "@/server/services/business-setup.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Pass 6b, POST /api/onboarding/business-setup
 *
 * Wizard's final commit. Body carries the vertical + the (possibly
 * edited) ItemType template. Server seeds an ItemType for the caller's
 * org via the existing `createItemType` path. Returns the created
 * ItemType DTO so the UI can route directly into the dynamic
 * create-order form pre-filtered to this type.
 *
 * RBAC: needs `ITEM_TYPE_MANAGE` (admin-only, matches the admin
 * Item-types editor). The wizard is exposed to admins only via the
 * dashboard onboarding checklist.
 */
export const POST = withApi(async (req: NextRequest) => {
  const actor = await requirePermission(Permission.ITEM_TYPE_MANAGE);
  const orgId = requireOrgId(actor.orgId);
  const body = await req.json();
  const input = completeBusinessSetupSchema.parse(body);
  const result = await completeBusinessSetup(input, {
    orgId,
    actorId: actor.id,
  });
  return jsonOk(result, { status: 201 });
});
