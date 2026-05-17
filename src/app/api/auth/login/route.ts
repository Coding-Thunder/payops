import { NextResponse, type NextRequest } from "next/server";

import { loginSchema } from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { setSessionCookie } from "@/server/auth/cookies";
import { authenticate } from "@/server/services/auth.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withApi(async (req: NextRequest) => {
  const body = await req.json();
  const input = loginSchema.parse(body);
  const ctx = await getRequestContext();
  const { token, user } = await authenticate(input, ctx);
  await setSessionCookie(token);
  return jsonOk(user) as NextResponse;
});
