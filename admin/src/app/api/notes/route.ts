import type { NextRequest } from "next/server";
import { z } from "zod";

import { getAdminEmail } from "@/server/auth/session";
import { addNote, NOTE_SUBJECTS } from "@/server/services/notes";
import { recordAdminAction } from "@/server/audit";
import { assertSameOrigin, jsonError, jsonOk, clientIp } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  subjectType: z.enum(NOTE_SUBJECTS),
  subjectId: z.string().min(1).max(64),
  body: z.string().min(1).max(5000),
});

export async function POST(req: NextRequest) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;

  const admin = await getAdminEmail();
  if (!admin) return jsonError(401, "Unauthorized");

  const body = await req.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) return jsonError(422, "A note body and subject are required");

  const res = await addNote({ ...parsed.data, authorEmail: admin });
  if (!res.ok) return jsonError(400, res.message ?? "Could not add note");

  await recordAdminAction({
    action: "note.add",
    actorEmail: admin,
    targetType: parsed.data.subjectType,
    targetId: parsed.data.subjectId,
    ip: clientIp(req),
  });
  return jsonOk({ note: res.note });
}
