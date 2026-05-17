import type { NextRequest } from "next/server";

import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { clearSessionCookie } from "@/server/auth/cookies";
import { getCurrentUser } from "@/server/auth/session";
import { recordLogout } from "@/server/services/auth.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withApi(async (_req: NextRequest) => {
  const user = await getCurrentUser();
  if (user) {
    const ctx = await getRequestContext();
    await recordLogout(user, ctx);
  }
  await clearSessionCookie();
  return jsonOk({ loggedOut: true });
});
