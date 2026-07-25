import "server-only";

import {
  cert,
  getApps,
  initializeApp,
  type App,
} from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";

import { env } from "@/server/env";

/**
 * Firebase Admin — verifies Google ID tokens server-side. Mirrors the
 * main app's `src/lib/firebase/admin.ts`. Returns null when
 * FIREBASE_SERVICE_ACCOUNT is unset, in which case the Google sign-in
 * route replies 503 and the UI keeps the email + OTP path.
 */
let cachedAuth: Auth | null = null;
let initFailed = false;

function buildAdminApp(): App | null {
  const raw = env.server.FIREBASE_SERVICE_ACCOUNT;
  if (!raw || raw.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as {
      project_id?: string;
      client_email?: string;
      private_key?: string;
    };
    if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
      throw new Error("FIREBASE_SERVICE_ACCOUNT missing required fields");
    }
    const privateKey = parsed.private_key.replace(/\\n/g, "\n");
    const existing = getApps()[0];
    if (existing) return existing;
    return initializeApp({
      credential: cert({
        projectId: parsed.project_id,
        clientEmail: parsed.client_email,
        privateKey,
      }),
    });
  } catch {
    initFailed = true;
    return null;
  }
}

export function getFirebaseAdminAuth(): Auth | null {
  if (cachedAuth) return cachedAuth;
  if (initFailed) return null;
  const app = buildAdminApp();
  if (!app) return null;
  cachedAuth = getAuth(app);
  return cachedAuth;
}

/**
 * Verify a Google ID token and return its verified email.
 * Throws when Firebase isn't configured or the token/email is invalid.
 */
export async function verifyGoogleIdToken(idToken: string): Promise<string> {
  const auth = getFirebaseAdminAuth();
  if (!auth) {
    const err = new Error("Firebase Auth is not configured");
    (err as { statusCode?: number }).statusCode = 503;
    throw err;
  }
  const decoded = await auth.verifyIdToken(idToken, true);
  if (!decoded.email || decoded.email_verified === false) {
    const err = new Error("Google account has no verified email");
    (err as { statusCode?: number }).statusCode = 401;
    throw err;
  }
  return decoded.email;
}
