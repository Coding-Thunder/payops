import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { AppError, UnauthorizedError } from "@/lib/errors";
import { getFirebaseAdminAuth } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { setSessionCookie } from "@/server/auth/cookies";
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
 * Returns 503 when Firebase Admin isn't configured — the UI can fall
 * back to the legacy bcrypt sign-in path in that case.
 */

const bodySchema = z.object({
  idToken: z.string().min(20, "idToken is required"),
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
    const { idToken } = bodySchema.parse(body);

    let decoded: { uid: string; email?: string; name?: string };
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

    const { token, user, isNewUser, orgId } = await firebaseExchange(
      {
        email: decoded.email,
        displayName: decoded.name ?? null,
        firebaseUid: decoded.uid,
      },
      ctx,
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
