import { NextResponse, type NextRequest } from "next/server";

import { forgotPasswordSchema } from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { verifyTurnstile } from "@/server/auth/turnstile";
import { initiatePasswordReset } from "@/server/services/password-reset.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Initiate a password reset.
 *
 * Always returns 200, never reveals whether the email is registered.
 * The service handles the "no user / disabled user" cases internally
 * by emitting an audit row + no email. Combined with the Turnstile
 * pre-flight + tight rate limit, this kills both account-enumeration
 * and reset-flood abuse.
 */
export const POST = withApi(
  async (req: NextRequest) => {
    const body = await req.json();
    const input = forgotPasswordSchema.parse(body);
    const ctx = await getRequestContext();
    await verifyTurnstile({ token: input.cfToken, remoteIp: ctx.ip });
    await initiatePasswordReset(input.email, { request: ctx });
    // Identical response shape regardless of outcome.
    return jsonOk({ initiated: true }) as NextResponse;
  },
  {
    rateLimit: { route: "auth-forgot-password", max: 5, windowMs: 15 * 60_000 },
    bodyLimitBytes: 4 * 1024,
  },
);
