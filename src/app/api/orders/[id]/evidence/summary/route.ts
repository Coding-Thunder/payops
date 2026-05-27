import { Permission } from "@/lib/constants/permissions";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { getEvidenceChainSummary } from "@/server/services/evidence.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * Lightweight chain summary for the order detail card. Avoids
 * streaming the full chain (with embedded email HTML) when all the
 * card needs is integrity + event count + last event.
 */
export const GET = withApi(async (_req: Request, { params }: Params) => {
  const actor = await requirePermission(Permission.EVIDENCE_VIEW);
  const { id } = await params;
  const summary = await getEvidenceChainSummary(id, {
    actor,
    orgId: actor.orgId,
  });
  return jsonOk(summary);
});
