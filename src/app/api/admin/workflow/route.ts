import { Permission } from "@/lib/constants/permissions";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { getOrCreateDefaultWorkflow } from "@/server/services/workflow.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/workflow — return the tenant's workflow (seeded on
 *  first access from the default 6 statuses + matching transitions). */
export const GET = withApi(async () => {
  const actor = await requirePermission(Permission.WORKFLOW_VIEW);
  if (!actor.orgId) {
    throw new Error("Your account is not attached to an organization.");
  }
  const workflow = await getOrCreateDefaultWorkflow(actor.orgId);
  return jsonOk({ workflow });
});
