import type { NextRequest } from "next/server";

import { getAdminEmail } from "@/console/server/auth/session";
import { assertSameOrigin, clientIp, jsonError, jsonOk } from "@/console/server/http";
import { removeAdmin } from "@/console/server/services/admins";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;

  const actor = await getAdminEmail();
  if (!actor) return jsonError(401, "UNAUTHORIZED", "Not signed in");

  const { id } = await params;
  const ip = clientIp(req);
  try {
    await removeAdmin(id, actor, ip);
    return jsonOk({ ok: true });
  } catch (err) {
    return jsonError(400, "BAD_REQUEST", err instanceof Error ? err.message : "Couldn't remove admin");
  }
}
