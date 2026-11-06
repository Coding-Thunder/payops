import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { AppError, UnauthorizedError } from "@/lib/errors";
import { getFirebaseAdminAuth } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { setSessionCookie } from "@/server/auth/cookies";
import { signupAllowed } from "@/server/auth/signup-gate";
import { verifyTurnstile } from "@/server/auth/turnstile";
import { firebaseExchange } from "@/server/services/auth.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Exchange a Firebase ID token for a TraceTxn session cookie.
 *
 * The client signs in via the Firebase Web SDK (email/password or
 * Google OAuth), then POSTs the resulting ID token here. The server
 * verifies the token with the Admin SDK, finds or provisions a Mongo
 * `User` (linking by `externalAuth.firebaseUid` or by email), then
 * mints the standard `tracetxn_session` JWT cookie so every
 * downstream auth surface (middleware, getCurrentUser, RBAC, audit)
 * keeps working unchanged.
 *
 * Returns 503 when Firebase Admin isn't configured, the UI can fall
 * back to the legacy bcrypt sign-in path in that case.
 */

const bodySchema = z.object({
  idToken: z.string().min(20, "idToken is required"),
  // Cloudflare Turnstile token. Optional in the schema so dev / not-
  // configured environments still post a valid body; `verifyTurnstile`
  // no-ops when TURNSTILE_SECRET_KEY is unset and throws when it IS
  // set but the token is missing or invalid.
  cfToken: z.string().optional(),
  // Break-glass invite code. Only matters in `invite_only` mode when a
  // net-new user is being provisioned; existing-user sign-in ignores it.
  inviteCode: z.string().optional(),
  // What the visitor was doing, as the form knows it.
  //
  // This used to be inferred from `inviteCode ? "signup" : "signin"`, which
  // was only ever correct because /signup always carried a code. Now that
  // signup is public a registration arrives with NO code, so the inference
  // called it a sign-in and a brand-new user was told "No TraceTxn account is
  // linked to …" — true, unhelpful, and the wrong half of the product. The
  // form states its own mode instead.
  //
  // It only selects the WORDING of a refusal. Authorization is decided by
  // `allowSignup` from the server-side mode, so a client claiming
  // intent:"signup" cannot thereby be allowed to sign up.
  intent: z.enum(["signin", "signup"]).optional(),
});

export const POST = withApi(
  async (req: NextRequest) => {
    const ctx = await getRequestContext();
    const adminAuth = getFirebaseAdminAuth();
    if (!adminAuth) {
      // 503 surfaces "service unavailable" cleanly. The client UI
      // catches it and tells the visitor to use the legacy form.
      throw new AppError(
        "EXTERNAL_SERVICE_ERROR",
        "Firebase Auth is not configured on the server",
        503,
      );
    }

    const body = await req.json();
    const { idToken, cfToken, inviteCode, intent } = bodySchema.parse(body);

    // Bot-check BEFORE the Firebase verify call so we don't burn
    // Identity Toolkit quota / latency on a request that's about to
    // be rejected. No-ops when TURNSTILE_SECRET_KEY isn't set.
    await verifyTurnstile({
      token: cfToken ?? null,
      remoteIp: ctx.ip ?? null,
    });

    let decoded: {
      uid: string;
      email?: string;
      email_verified?: boolean;
      name?: string;
    };
    try {
      // checkRevoked=true so an admin who disabled a Firebase user in
      // the console takes effect on the next token presentation.
      decoded = await adminAuth.verifyIdToken(idToken, true);
    } catch (err) {
      logger.warn("auth.firebase.verify_failed", {
        err: err instanceof Error ? err.message : String(err),
      });
      throw new UnauthorizedError("Invalid or expired Firebase token");
    }

    if (!decoded.email) {
      throw new UnauthorizedError(
        "Firebase token is missing an email claim",
      );
    }

    // The form states its own mode; fall back to the old inference for a
    // client that does not send one (a cached bundle mid-deploy, or a direct
    // caller). "signin" is the safe default: it cannot provision.
    const effectiveIntent = intent ?? (inviteCode ? "signup" : "signin");
    const wantsSignup = effectiveIntent === "signup";

    const { token, user, isNewUser, orgId } = await firebaseExchange(
      {
        email: decoded.email,
        // Only a verified email may link to / provision an account (prevents
        // Firebase email-linking account takeover). Google OAuth always sets
        // this true; email/password must verify first.
        emailVerified: decoded.email_verified === true,
        displayName: decoded.name ?? null,
        firebaseUid: decoded.uid,
      },
      ctx,
      {
        // Net-new provisioning requires BOTH that the visitor was trying to
        // register and that the mode allows it.
        //
        // The mode alone is not enough. /login posts through this same route
        // with no invite code, so `signupAllowed(inviteCode)` on its own —
        // true for everyone once signup went public — turned the SIGN-IN page
        // into a provisioning surface. A returning customer who picked the
        // wrong account from the Google chooser (the case auth.service.ts
        // calls the usual cause) would then be handed a brand-new empty
        // workspace and dropped into it, instead of being told "No TraceTxn
        // account is linked to …". They would conclude their data was gone.
        //
        // Conjoining the two can only ever REFUSE, never grant: a client
        // claiming intent:"signup" still has to get past the mode, and
        // nothing a client sends can widen what `signupAllowed` permits.
        // Absent intent reads as "signin", so an unknown caller gets the
        // safe answer rather than a tenant.
        //
        // This is the ownership-proving door: email+password arrives here
        // UNVERIFIED and `firebaseExchange` refuses to provision until the
        // visitor has clicked the verification mail, while Google arrives
        // pre-verified by the provider. So opening signup does not let anyone
        // claim an address they do not control.
        allowSignup: wantsSignup && signupAllowed(inviteCode),
        intent: effectiveIntent,
      },
    );
    await setSessionCookie(token);

    return jsonOk({ user, isNewUser, orgId }) as NextResponse;
  },
  {
    // Firebase already imposes its own per-IP rate limits at the
    // verify-token edge. Keep a defensive ceiling here so a stolen
    // refresh token can't flood our DB with provisioning writes.
    rateLimit: { route: "auth-firebase", max: 10, windowMs: 60_000 },
    bodyLimitBytes: 8 * 1024, // ID tokens are ~1-2 KB
  },
);
