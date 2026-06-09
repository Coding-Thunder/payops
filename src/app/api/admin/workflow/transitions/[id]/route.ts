import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { removeTransition } from "@/server/services/workflow.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

/** DELETE /api/admin/workflow/transitions/:id, remove an edge by id.
 *  Always safe (transitions have no downstream references). */
export const DELETE = withApi(
  async (_req: NextRequest, { params }: Params) => {
    const actor = await requirePermission(Permission.WORKFLOW_MANAGE);
    if (!actor.orgId) {
      throw new Error("Your account is not attached to an organization.");
    }
    const { id } = await params;
    const workflow = await removeTransition(actor.orgId, id, { id: actor.id });
    return jsonOk({ workflow });
  },
);
