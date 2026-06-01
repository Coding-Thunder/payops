import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { templateKeyParam } from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { activateTemplateVersion } from "@/server/services/email-template.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ key: string; versionId: string }>;
}

/**
 * Flip the active flag to a previously-saved historical version.
 * Atomic at the (templateKey) level, deactivates whatever was active.
 */
export const POST = withApi(async (_req: NextRequest, { params }: Params) => {
  const actor = await requirePermission(Permission.EMAIL_TEMPLATE_MANAGE);
  const { key, versionId } = await params;
  const templateKey = templateKeyParam.parse(key);
  const ctx = await getRequestContext();
  const version = await activateTemplateVersion(templateKey, versionId, {
    actor,
    orgId: actor.orgId,
    request: ctx,
  });
  return jsonOk(version);
});
