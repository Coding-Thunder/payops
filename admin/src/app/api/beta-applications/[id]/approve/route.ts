import type { NextRequest } from "next/server";

import { getAdminEmail } from "@/server/auth/session";
import { assertSameOrigin, clientIp, jsonError, jsonOk } from "@/server/http";
import { approveBetaApplication } from "@/server/services/beta-applications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Approve (or retry the invite for) an application. Admin-auth required. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;
  const actor = await getAdminEmail();
  if (!actor) return jsonError(401, "Not signed in");
  const { id } = await params;
  try {
    const result = await approveBetaApplication(id, actor, clientIp(req));
    return jsonOk(result);
  } catch (err) {
    return jsonError(400, err instanceof Error ? err.message : "Couldn't approve");
  }
}
