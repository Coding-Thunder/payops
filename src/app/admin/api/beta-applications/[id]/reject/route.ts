import type { NextRequest } from "next/server";
import { z } from "zod";

import { getAdminEmail } from "@/console/server/auth/session";
import { assertSameOrigin, clientIp, jsonError, jsonOk } from "@/console/server/http";
import { rejectBetaApplication } from "@/console/server/services/beta-applications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ note: z.string().max(4000).optional() });

/** Reject an application. Sends no account access. Admin-auth required. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;
  const actor = await getAdminEmail();
  if (!actor) return jsonError(401, "UNAUTHORIZED", "Not signed in");
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) return jsonError(422, "VALIDATION_ERROR", "Invalid input");
  try {
    await rejectBetaApplication(id, actor, parsed.data.note, clientIp(req));
    return jsonOk({ ok: true });
  } catch (err) {
    return jsonError(400, "BAD_REQUEST", err instanceof Error ? err.message : "Couldn't reject");
  }
}
