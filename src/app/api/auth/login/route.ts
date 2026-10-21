import { NextResponse, type NextRequest } from "next/server";

import { AppError } from "@/lib/errors";
import { loginSchema } from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { setSessionCookie } from "@/server/auth/cookies";
import { passwordLoginEnabled } from "@/server/auth/password-login-gate";
import { verifyTurnstile } from "@/server/auth/turnstile";
import { authenticate } from "@/server/services/auth.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withApi(
  async (req: NextRequest) => {
    // Closed by default. See server/auth/password-login-gate.ts: this route
    // checks Mongo bcrypt, not Firebase, so it can admit an identity Firebase
    // would refuse. The smoke suite is the only legitimate caller and sets the
    // flag explicitly.
    if (!passwordLoginEnabled()) {
      throw new AppError(
        "NOT_FOUND",
        "This sign-in method is not available.",
        404,
      );
    }
    const body = await req.json();
    const input = loginSchema.parse(body);
    const ctx = await getRequestContext();
    // Cloudflare Turnstile pre-flight (no-op when secret unset). Runs
    // BEFORE bcrypt so a bot wave can't burn CPU on password verifies.
    await verifyTurnstile({ token: input.cfToken, remoteIp: ctx.ip });
    const { token, user } = await authenticate(input, ctx);
    await setSessionCookie(token);
    return jsonOk(user) as NextResponse;
  },
  {
    // 5 attempts per 5 min per caller, paired with the per-failure
    // audit row, this kills the credential-stuffing path without
    // locking out a real operator who fat-fingered their password.
    rateLimit: { route: "auth-login", max: 5, windowMs: 5 * 60_000 },
    bodyLimitBytes: 4 * 1024,
  },
);
