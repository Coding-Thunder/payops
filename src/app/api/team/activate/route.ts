import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { setSessionCookie } from "@/server/auth/cookies";
import { signSession } from "@/server/auth/jwt";
import { activateTeamInvite } from "@/server/services/team-invite.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Team-invite activation. The single-use invitation token is the ONLY
 * authorization — the invited member's identity + target org are read from
 * the bound OrgMember/User (never the request), and the token is atomically
 * consumed inside the service. On success the member sets their own password,
 * their account flips ACTIVE, and a session is minted for the JOINED org with
 * the member's role (never SUPER_ADMIN, never a new workspace).
 *
 * Public + unauthenticated but token-gated: invalid/expired/used all surface
 * one generic error (enumeration-safe), the raw token is never logged, and
 * the endpoint is rate-limited to blunt automated abuse.
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
});

export const POST = withApi(
  async (req: NextRequest) => {
    const body = await req.json();
    const input = schema.parse(body);
    const ctx = await getRequestContext();

    const result = await activateTeamInvite(
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
    rateLimit: { route: "team-activate", max: 10, windowMs: 15 * 60_000 },
    bodyLimitBytes: 4 * 1024,
  },
);
