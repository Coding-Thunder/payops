import type { NextRequest } from "next/server";

import { getAdminEmail } from "@/server/auth/session";
import { resendEmail } from "@/server/services/email-ops";
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
  const res = await resendEmail(id);
  if (!res.ok) return jsonError(409, res.message ?? "Cannot resend", "CONFLICT");

  await recordAdminAction({
    action: "email.resend",
    actorEmail: admin,
    targetType: "pending_email",
    targetId: id,
    metadata: { newId: res.newId ?? null },
    ip: clientIp(req),
  });
  return jsonOk({ ok: true, newId: res.newId });
}
