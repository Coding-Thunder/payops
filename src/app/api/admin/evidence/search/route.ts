import type { NextRequest } from "next/server";

import { ForbiddenError } from "@/lib/errors";
import { Permission } from "@/lib/constants/permissions";
import { evidenceSearchSchema } from "@/lib/validation";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { searchEvidence } from "@/server/services/evidence.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Admin / dispute-team search across the evidence chain. Looks up
 * orders by any of the indexed `refs.*` fields plus orderNumber.
 *
 * Quality-of-life: callers can paste a raw consent token; the service
 * hashes it before searching so we never persist or compare raw tokens.
 */
export const GET = withApi(async (req: NextRequest) => {
  const actor = await requirePermission(Permission.EVIDENCE_VIEW);
  if (!actor.orgId) throw new ForbiddenError("Active organization required");
  const url = new URL(req.url);
  const input = evidenceSearchSchema.parse({
    q: url.searchParams.get("q") ?? "",
    field: url.searchParams.get("field") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });
  const results = await searchEvidence(input, { actor, orgId: actor.orgId });
  return jsonOk({ results });
});
