import type { NextRequest } from "next/server";

import { getAdminEmail } from "@/console/server/auth/session";
import { sendUserPasswordReset } from "@/console/server/services/support";
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
  const res = await sendUserPasswordReset(id);
  if (!res.ok) {
    return jsonError(400, "BAD_REQUEST", res.message ?? "Could not send reset link");
  }

  await recordAdminAction({
    action: "user.reset_password_link",
    actorEmail: admin,
    targetType: "user",
    targetId: id,
    ip: clientIp(req),
  });
  return jsonOk({ ok: true });
}
