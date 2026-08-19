import type { NextRequest } from "next/server";

import { getAdminEmail } from "@/console/server/auth/session";
import { deleteNote } from "@/console/server/services/notes";
import { recordAdminAction } from "@/console/server/audit";
import { assertSameOrigin, jsonError, jsonOk, clientIp } from "@/console/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;

  const admin = await getAdminEmail();
  if (!admin) return jsonError(401, "UNAUTHORIZED", "Unauthorized");

  const { id } = await ctx.params;
  const ok = await deleteNote(id);
  if (!ok) return jsonError(404, "NOT_FOUND", "Note not found");

  await recordAdminAction({
    action: "note.delete",
    actorEmail: admin,
    targetType: "note",
    targetId: id,
    ip: clientIp(req),
  });
  return jsonOk({ ok: true });
}
