import type { NextRequest } from "next/server";

import { getAdminEmail } from "@/server/auth/session";
import { deleteNote } from "@/server/services/notes";
import { recordAdminAction } from "@/server/audit";
import { assertSameOrigin, jsonError, jsonOk, clientIp } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;

  const admin = await getAdminEmail();
  if (!admin) return jsonError(401, "Unauthorized");

  const { id } = await ctx.params;
  const ok = await deleteNote(id);
  if (!ok) return jsonError(404, "Note not found");

  await recordAdminAction({
    action: "note.delete",
    actorEmail: admin,
    targetType: "note",
    targetId: id,
    ip: clientIp(req),
  });
  return jsonOk({ ok: true });
}
