import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { getClientTimeline } from "@/server/services/client-profile.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

/** The client's chronological cross-entity timeline (orders, payments,
 *  refunds, consent, documents, disputes), newest first. */
export const GET = withApi(async (_req: NextRequest, { params }: Params) => {
  const actor = await requirePermission(Permission.CUSTOMER_VIEW);
  const { id } = await params;
  const events = await getClientTimeline(actor.orgId, id);
  return jsonOk({ events });
});
