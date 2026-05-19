import { Permission } from "@/lib/constants/permissions";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { getEvidenceChain } from "@/server/services/evidence.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * Read the full dispute-grade evidence chain for an order.
 *
 * Returns the chronological list of hash-chained events plus a
 * verification block the UI uses to render the integrity badge. The
 * page renders server-side and hits the service directly, but a JSON
 * route is exposed for the admin search page's "Open chain" CTA and
 * for the PDF export pre-flight.
 */
export const GET = withApi(async (_req: Request, { params }: Params) => {
  const actor = await requirePermission(Permission.EVIDENCE_VIEW);
  const { id } = await params;
  const chain = await getEvidenceChain(id, { actor });
  return jsonOk(chain);
});
