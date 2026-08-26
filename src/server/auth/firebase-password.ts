import "server-only";

import { getFirebaseAdminAuth } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";

/**
 * Keep Firebase Auth in step with a password chosen through this app.
 *
 * Shared by every flow that sets a tenant password, because the two stores had
 * already drifted once: /login renders FirebaseAuthForm and calls
 * `signInWithEmailAndPassword`, so Firebase is what browser sign-in reads,
 * while password-reset and beta activation wrote only a bcrypt hash to Mongo.
 * A user set their password and was then told it was wrong.
 *
 * The Mongo hash is still written by those callers and is NOT vestigial: POST
 * /api/auth/login authenticates against it and is how the Playwright smoke
 * suite signs in (src/tests/smoke/_helpers.ts). Both stores, always.
 *
 * `emailVerified: true` on BOTH branches: every caller reaches this only after
 * the user redeemed a single-use link delivered to that mailbox, which is the
 * same proof of control /api/auth/firebase-session demands before it will link
 * an identity — and that route rejects unverified ones, so omitting this
 * produces a working Firebase password that still cannot open a session.
 *
 * A missing service account is not fatal: getFirebaseAdminAuth() returns null
 * when FIREBASE_SERVICE_ACCOUNT is unset (local dev, smoke runs, and any
 * deployment still on the bcrypt path). Logged at error level because in a
 * Firebase-backed deployment it means passwords are silently not taking
 * effect for browser sign-in.
 */
export async function syncFirebasePassword(
  email: string,
  newPassword: string,
): Promise<void> {
  const auth = getFirebaseAdminAuth();
  if (!auth) {
    logger.error("firebase_password.unconfigured", {
      email,
      msg: "FIREBASE_SERVICE_ACCOUNT is unset, so the password was written to Mongo only. If this deployment signs in through Firebase, the user cannot use it.",
    });
    return;
  }

  try {
    const existing = await auth.getUserByEmail(email);
    await auth.updateUser(existing.uid, {
      password: newPassword,
      emailVerified: true,
    });
    // Changing the password does NOT invalidate Firebase refresh tokens. Without
    // this, anyone holding one could mint a fresh ID token and trade it at
    // /api/auth/firebase-session for a brand-new app session, walking straight
    // past the caller's own session revocation. That route already verifies
    // with checkRevoked=true, so the machinery existed; nothing called it.
    await auth.revokeRefreshTokens(existing.uid);
    logger.info("firebase_password.updated", { uid: existing.uid });
  } catch (err) {
    if ((err as { code?: string } | null)?.code === "auth/user-not-found") {
      const created = await auth.createUser({
        email,
        password: newPassword,
        emailVerified: true,
      });
      logger.info("firebase_password.provisioned", { uid: created.uid });
      return;
    }
    throw err;
  }
}
