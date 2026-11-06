import { NextResponse, type NextRequest } from "next/server";

import { ForbiddenError } from "@/lib/errors";
import { signupSchema } from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { setSessionCookie } from "@/server/auth/cookies";
import { signSession } from "@/server/auth/jwt";
import { signupInviteAccepted } from "@/server/auth/signup-gate";
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
 * per 15 min per IP), paired with the per-failure audit row we get
 * via the standard `withApi` pipeline.
 *
 * That stops SCRIPTED abuse. It does nothing about disposable addresses —
 * neither check ever looks at the domain, so one person with a throwaway
 * inbox open walks straight through. Disposable domains are rejected in
 * `signupSchema` itself (see `@/lib/validation/disposable-email`), which is
 * server-side rather than bolted onto this one route.
 *
 * NOT, however, shared by every signup path, which this comment used to
 * claim. `signupSchema` guards THIS route, and this route is invite-gated
 * and has no production caller. The public path — the Firebase exchange at
 * `/api/auth/firebase-session` — never evaluates the denylist, so
 * `anything@yopmail.com` is accepted at /signup while the identical address
 * is rejected here. See `@/server/auth/signup-gate` for why that gap is
 * recorded rather than closed in the same change that opened signup.
 *
 * Phase 4 is the FIRST public-write endpoint. Everything else is
 * either auth-gated or signature-gated. The rate limit + Turnstile
 * + email-uniqueness errors together form the perimeter.
 */
export const POST = withApi(
  async (req: NextRequest) => {
    const body = await req.json();
    // DELIBERATELY NOT PUBLIC, even though signup itself now is.
    //
    // This route provisions through `signupFounder`, which calls
    // `syncFirebasePassword` and therefore marks the Firebase identity
    // `emailVerified: true` for an address the caller merely typed — there is
    // no mailbox round trip anywhere on this path. Behind a code that is
    // contained; open to the internet it would let anyone squat an address
    // AND mint an identity that `firebaseExchange` later trusts for account
    // LINKING, because the anti-takeover guard reads that same flag.
    //
    // The public door is the Firebase client flow behind /signup, which proves
    // control of the address before provisioning. So the check here stays
    // `signupInviteAccepted` (the code) rather than `signupAllowed` (the mode).
    const invite =
      body && typeof body.invite === "string" ? body.invite : undefined;
    if (!signupInviteAccepted(invite)) {
      throw new ForbiddenError(
        "TraceTxn is in private beta — signups are invite-only. Please use an invitation to create an account.",
      );
    }
    const input = signupSchema.parse(body);
    const ctx = await getRequestContext();
    await verifyTurnstile({ token: input.cfToken, remoteIp: ctx.ip });

    const result = await signupFounder(input, ctx);

    // Mint a JWT for the brand-new founder, same shape login emits,
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
