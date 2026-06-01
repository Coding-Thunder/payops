/**
 * Firebase Web SDK, browser-side init.
 *
 * Lazy-initialized so the bundle stays tree-shakeable for any page
 * that doesn't actually call into Firebase Auth. Returns null when
 * the NEXT_PUBLIC_FIREBASE_* config is incomplete, callers must
 * handle that and fall back to the legacy bcrypt path.
 */
import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";

import { env } from "@/lib/env";

let cachedAuth: Auth | null = null;

function buildConfig(): {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
} | null {
  const c = env.public;
  if (
    !c.NEXT_PUBLIC_FIREBASE_API_KEY ||
    !c.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ||
    !c.NEXT_PUBLIC_FIREBASE_PROJECT_ID ||
    !c.NEXT_PUBLIC_FIREBASE_APP_ID
  ) {
    return null;
  }
  return {
    apiKey: c.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: c.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: c.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    storageBucket: c.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ?? "",
    messagingSenderId: c.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ?? "",
    appId: c.NEXT_PUBLIC_FIREBASE_APP_ID,
  };
}

export function isFirebaseConfigured(): boolean {
  return buildConfig() !== null;
}

export function getFirebaseAuth(): Auth | null {
  if (cachedAuth) return cachedAuth;
  const config = buildConfig();
  if (!config) return null;
  const app: FirebaseApp =
    getApps()[0] ?? initializeApp(config);
  cachedAuth = getAuth(app);
  return cachedAuth;
}
