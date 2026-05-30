import "server-only";

import {
  cert,
  getApps,
  initializeApp,
  type App,
} from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";

import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

/**
 * Firebase Admin SDK — server-side init.
 *
 * Reads FIREBASE_SERVICE_ACCOUNT from env (single-line JSON), parses
 * it once, and caches the resulting Auth instance. Returns null when
 * the env var is missing or malformed — callers in API routes return
 * 503 in that case so the UI can fall back to the legacy bcrypt
 * sign-in path.
 *
 * Treat the service account JSON as a high-value secret. Loss of the
 * key means rotating it in GCP Console → IAM → Service Accounts.
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
      throw new Error(
        "FIREBASE_SERVICE_ACCOUNT JSON missing required fields (project_id / client_email / private_key)",
      );
    }
    // The private_key field carries literal "\n" sequences when
    // pasted through dotenv-style env files. Normalise to real
    // newlines before handing to the admin SDK.
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
  } catch (err) {
    initFailed = true;
    logger.error("firebase.admin.init_failed", {
      err: err instanceof Error ? err.message : String(err),
    });
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

/** True iff the admin SDK is wired and ready to verify ID tokens. */
export function isFirebaseAdminConfigured(): boolean {
  return getFirebaseAdminAuth() !== null;
}
