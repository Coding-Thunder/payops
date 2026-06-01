import type { NextRequest } from "next/server";

import { ForbiddenError } from "@/lib/errors";
import { Permission } from "@/lib/constants/permissions";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { verifyConsent } from "@/server/services/consent.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * Admin action: lock a RECEIVED consent record as dispute-grade
 * evidence. Permission gate intentionally narrower than CONSENT_VIEW -
 * staff who can read records still can't rubber-stamp them.
 */
export const POST = withApi(async (_req: NextRequest, { params }: Params) => {
  const actor = await requirePermission(Permission.CONSENT_VERIFY);
  if (!actor.orgId) throw new ForbiddenError("Active organization required");
  const { id } = await params;
  const reqCtx = await getRequestContext();
  const consent = await verifyConsent(id, {
    actor,
    orgId: actor.orgId,
    request: reqCtx,
  });
  return jsonOk({ consent });
});
