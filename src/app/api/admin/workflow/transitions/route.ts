import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { addTransitionSchema } from "@/lib/validation";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { addTransition } from "@/server/services/workflow.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/admin/workflow/transitions, add an edge between two
 *  existing statuses. Service validates both sides exist + no duplicate
 *  (from, to) pair. */
export const POST = withApi(async (req: NextRequest) => {
  const actor = await requirePermission(Permission.WORKFLOW_MANAGE);
  if (!actor.orgId) {
    throw new Error("Your account is not attached to an organization.");
  }
  const input = addTransitionSchema.parse(await req.json());
  const workflow = await addTransition(actor.orgId, input, { id: actor.id });
  return jsonOk({ workflow }, { status: 201 });
});
