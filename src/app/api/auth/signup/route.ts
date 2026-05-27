import { NextResponse, type NextRequest } from "next/server";

import { signupSchema } from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { setSessionCookie } from "@/server/auth/cookies";
import { signSession } from "@/server/auth/jwt";
import { verifyTurnstile } from "@/server/auth/turnstile";
import { signupFounder } from "@/server/services/signup.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public self-serve signup.
 *
 * Creates an Organization + SUPER_ADMIN User + OrgMember atomically,
 * mints a JWT carrying `{orgId, orgIds: [orgId]}`, and sets the
 * session cookie so the browser lands logged-in.
 *
 * Bot protection: Turnstile pre-flight, then a tight rate limit (5
 * per 15 min per IP) — paired with the per-failure audit row we get
 * via the standard `withApi` pipeline, this kills disposable-email
 * abuse without locking real founders out.
 *
 * Phase 4 is the FIRST public-write endpoint. Everything else is
 * either auth-gated or signature-gated. The rate limit + Turnstile
 * + email-uniqueness errors together form the perimeter.
 */
export const POST = withApi(
  async (req: NextRequest) => {
    const body = await req.json();
    const input = signupSchema.parse(body);
    const ctx = await getRequestContext();
    await verifyTurnstile({ token: input.cfToken, remoteIp: ctx.ip });

    const result = await signupFounder(input, ctx);

    // Mint a JWT for the brand-new founder — same shape login emits,
    // including the orgIds array so a future multi-org user can switch
    // without re-issuance.
    const token = await signSession({
      sub: result.user.id,
      email: result.user.email,
      name: result.user.name,
      role: result.user.role,
      orgId: result.orgId,
      orgIds: [result.orgId],
    });
    await setSessionCookie(token);
    return jsonOk(result) as NextResponse;
  },
  {
    rateLimit: { route: "auth-signup", max: 5, windowMs: 15 * 60_000 },
    bodyLimitBytes: 4 * 1024,
  },
);
