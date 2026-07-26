import type { NextRequest } from "next/server";

import { getAdminEmail } from "@/server/auth/session";
import { grantAccessToWaitlist } from "@/server/services/provision";
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
  const result = await grantAccessToWaitlist(id, admin, clientIp(req));
  if (result.status === "error") return jsonError(400, result.message);
  return jsonOk(result);
}
