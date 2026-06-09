import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { addStatusSchema } from "@/lib/validation";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { addStatus } from "@/server/services/workflow.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/admin/workflow/statuses, append a new status to the
 *  tenant's workflow. Status keys must be unique within the workflow;
 *  service throws ValidationError on collision. */
export const POST = withApi(async (req: NextRequest) => {
  const actor = await requirePermission(Permission.WORKFLOW_MANAGE);
  if (!actor.orgId) {
    throw new Error("Your account is not attached to an organization.");
  }
  const input = addStatusSchema.parse(await req.json());
  const workflow = await addStatus(actor.orgId, input, { id: actor.id });
  return jsonOk({ workflow }, { status: 201 });
});
