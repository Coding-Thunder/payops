"use client";

import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  type Auth,
} from "firebase/auth";

/**
 * Browser-side Firebase for the Google sign-in button. Reads NEXT_PUBLIC_*
 * directly (Next inlines them) — deliberately does NOT import the
 * server-only env module. Returns null when config is incomplete so the
 * login UI hides the Google button and keeps the email + OTP path.
 */
function config() {
  const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
  const authDomain = process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN;
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  const appId = process.env.NEXT_PUBLIC_FIREBASE_APP_ID;
  if (!apiKey || !authDomain || !projectId || !appId) return null;
  return {
    apiKey,
    authDomain,
    projectId,
    appId,
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ?? "",
    messagingSenderId:
      process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ?? "",
  };
}

export function isFirebaseConfigured(): boolean {
  return config() !== null;
}

let cachedAuth: Auth | null = null;
function auth(): Auth | null {
  if (cachedAuth) return cachedAuth;
  const c = config();
  if (!c) return null;
  const app: FirebaseApp = getApps()[0] ?? initializeApp(c);
  cachedAuth = getAuth(app);
  return cachedAuth;
}

/** Open the Google popup and return a fresh Firebase ID token. */
export async function googleSignInIdToken(): Promise<string> {
  const a = auth();
  if (!a) throw new Error("Google sign-in is not configured");
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  const cred = await signInWithPopup(a, provider);
  return cred.user.getIdToken();
}
