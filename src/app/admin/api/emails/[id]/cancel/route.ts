import type { NextRequest } from "next/server";

import { getAdminEmail } from "@/console/server/auth/session";
import { cancelEmail } from "@/console/server/services/email-ops";
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
  const res = await cancelEmail(id);
  if (!res.ok) return jsonError(409, "CONFLICT", res.message ?? "Cannot cancel");

  await recordAdminAction({
    action: "email.cancel",
    actorEmail: admin,
    targetType: "pending_email",
    targetId: id,
    ip: clientIp(req),
  });
  return jsonOk({ ok: true });
}
