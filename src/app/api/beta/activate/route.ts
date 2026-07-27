import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { setSessionCookie } from "@/server/auth/cookies";
import { signSession } from "@/server/auth/jwt";
import { verifyTurnstile } from "@/server/auth/turnstile";
import { activateFromToken } from "@/server/services/beta-application.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Beta account activation. The single-use invitation token is the ONLY
 * authorization — the email is taken from the bound application, never from
 * the request, and the token is atomically consumed inside the service. This
 * is the sole account-creation path enabled during the private beta; public
 * self-serve signup stays closed.
 */
const schema = z.object({
  token: z.string().min(16).max(512),
  name: z.string().trim().max(120).optional(),
  password: z
    .string()
    .min(10, "Use at least 10 characters")
    .max(200)
    .regex(/[A-Z]/, "Include an uppercase letter")
    .regex(/[a-z]/, "Include a lowercase letter")
    .regex(/[0-9]/, "Include a number"),
  cfToken: z.string().max(2048).optional(),
});

export const POST = withApi(
  async (req: NextRequest) => {
    const body = await req.json();
    const input = schema.parse(body);
    const ctx = await getRequestContext();
    await verifyTurnstile({ token: input.cfToken, remoteIp: ctx.ip });

    const result = await activateFromToken(
      input.token,
      { name: input.name, password: input.password },
      ctx,
    );

    const token = await signSession({
      sub: result.user.id,
      email: result.user.email,
      name: result.user.name,
      role: result.user.role,
      orgId: result.orgId,
      orgIds: [result.orgId],
    });
    await setSessionCookie(token);
    return jsonOk({ ok: true }) as NextResponse;
  },
  {
    rateLimit: { route: "beta-activate", max: 10, windowMs: 15 * 60_000 },
    bodyLimitBytes: 4 * 1024,
  },
);
