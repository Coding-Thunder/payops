import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { editStatusSchema } from "@/lib/validation";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { editStatus, removeStatus } from "@/server/services/workflow.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ key: string }>;
}

/** PATCH /api/admin/workflow/statuses/:key, edit a status's display
 *  fields (label / color / terminal / paid). The status key itself is
 *  immutable to avoid orphaning every Order.status pointing at it. */
export const PATCH = withApi(async (req: NextRequest, { params }: Params) => {
  const actor = await requirePermission(Permission.WORKFLOW_MANAGE);
  if (!actor.orgId) {
    throw new Error("Your account is not attached to an organization.");
  }
  const { key } = await params;
  const input = editStatusSchema.parse(await req.json());
  const workflow = await editStatus(actor.orgId, key, input, { id: actor.id });
  return jsonOk({ workflow });
});

/** DELETE /api/admin/workflow/statuses/:key, remove a status. Service
 *  refuses for load-bearing statuses (initial, payment mappings, or
 *  referenced by transitions). */
export const DELETE = withApi(
  async (_req: NextRequest, { params }: Params) => {
    const actor = await requirePermission(Permission.WORKFLOW_MANAGE);
    if (!actor.orgId) {
      throw new Error("Your account is not attached to an organization.");
    }
    const { key } = await params;
    const workflow = await removeStatus(actor.orgId, key, { id: actor.id });
    return jsonOk({ workflow });
  },
);
