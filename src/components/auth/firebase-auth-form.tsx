"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
  type AuthError,
} from "firebase/auth";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadingButton } from "@/components/ui/loading-button";
import { api, ApiClientError } from "@/lib/api-client";
import { getFirebaseAuth, isFirebaseConfigured } from "@/lib/firebase/client";

/**
 * Firebase-backed sign-in + sign-up form.
 *
 * Mode is set by the caller — "signin" only attempts to log in
 * existing accounts; "signup" creates a new Firebase user + provisions
 * a TraceTxn workspace on first server exchange.
 *
 * Google OAuth is always available alongside the password flow when
 * Firebase is configured. When Firebase isn't configured (no
 * NEXT_PUBLIC_FIREBASE_* env), the component renders a "not
 * configured" notice and the legacy bcrypt form on the page handles
 * the rest.
 */

interface FirebaseAuthFormProps {
  mode: "signin" | "signup";
  nextPath?: string;
}

interface FirebaseSessionResponse {
  user: { id: string; name: string; email: string; role: string };
  isNewUser: boolean;
  orgId: string | null;
}

export function FirebaseAuthForm({ mode, nextPath }: FirebaseAuthFormProps) {
  const router = useRouter();
  const configured = isFirebaseConfigured();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<null | "email" | "google">(null);
  const [error, setError] = useState<string | null>(null);

  if (!configured) {
    return (
      <Alert>
        <AlertTitle>Firebase sign-in unavailable</AlertTitle>
        <AlertDescription>
          Firebase Auth isn&apos;t configured for this environment. Use
          the email + password form below.
        </AlertDescription>
      </Alert>
    );
  }

  async function exchangeIdTokenForSession(idToken: string): Promise<void> {
    const result = await api.post<FirebaseSessionResponse>(
      "/api/auth/firebase-session",
      { idToken },
    );
    router.replace(safeNext(nextPath));
    router.refresh();
    return void result;
  }

  async function handleEmailSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const auth = getFirebaseAuth();
    if (!auth) {
      setError("Firebase Auth client failed to initialize");
      return;
    }
    setBusy("email");
    try {
      const credential =
        mode === "signup"
          ? await createUserWithEmailAndPassword(auth, email, password)
          : await signInWithEmailAndPassword(auth, email, password);
      const idToken = await credential.user.getIdToken();
      await exchangeIdTokenForSession(idToken);
    } catch (err) {
      setError(humanizeAuthError(err, mode));
    } finally {
      setBusy(null);
    }
  }

  async function handleGoogle() {
    setError(null);
    const auth = getFirebaseAuth();
    if (!auth) {
      setError("Firebase Auth client failed to initialize");
      return;
    }
    setBusy("google");
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      const credential = await signInWithPopup(auth, provider);
      const idToken = await credential.user.getIdToken();
      await exchangeIdTokenForSession(idToken);
    } catch (err) {
      setError(humanizeAuthError(err, mode));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-5">
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>
            {mode === "signup" ? "Sign-up failed" : "Sign-in failed"}
          </AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <Button
        type="button"
        variant="outline"
        className="w-full gap-2 h-10"
        onClick={handleGoogle}
        disabled={busy !== null}
      >
        <GoogleIcon className="size-4" aria-hidden />
        {busy === "google"
          ? "Opening Google…"
          : mode === "signup"
            ? "Sign up with Google"
            : "Continue with Google"}
      </Button>

      <div className="relative">
        <div className="absolute inset-0 flex items-center" aria-hidden>
          <span className="w-full border-t border-border" />
        </div>
        <div className="relative flex justify-center">
          <span className="bg-background px-2 text-[10.5px] uppercase tracking-[0.16em] text-muted-foreground">
            or with email
          </span>
        </div>
      </div>

      <form className="space-y-4" onSubmit={handleEmailSubmit} noValidate>
        <div className="space-y-1.5">
          <Label htmlFor="fb-email">Work email</Label>
          <Input
            id="fb-email"
            type="email"
            autoComplete="email"
            inputMode="email"
            placeholder="you@company.com"
            disabled={busy !== null}
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="fb-password">Password</Label>
            {mode === "signin" ? (
              <a
                href="/forgot-password"
                className="text-[11px] text-muted-foreground hover:text-foreground underline-offset-4 hover:underline"
              >
                Forgot?
              </a>
            ) : null}
          </div>
          <Input
            id="fb-password"
            type="password"
            autoComplete={
              mode === "signup" ? "new-password" : "current-password"
            }
            placeholder={
              mode === "signup" ? "At least 8 characters" : "••••••••"
            }
            disabled={busy !== null}
            required
            minLength={mode === "signup" ? 8 : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        <LoadingButton
          type="submit"
          className="w-full"
          loading={busy === "email"}
          loadingText={mode === "signup" ? "Creating account" : "Signing in"}
        >
          {mode === "signup" ? "Create account" : "Sign in"}
        </LoadingButton>
      </form>
    </div>
  );
}

function safeNext(value?: string): string {
  if (!value) return "/app/dashboard";
  if (!value.startsWith("/")) return "/app/dashboard";
  if (value.startsWith("//")) return "/app/dashboard";
  if (value.startsWith("/login")) return "/app/dashboard";
  if (value.startsWith("/signup")) return "/app/dashboard";
  return value;
}

function humanizeAuthError(err: unknown, mode: "signin" | "signup"): string {
  // Server-side exchange error (after Firebase succeeded).
  if (err instanceof ApiClientError) return err.message;
  // Firebase Auth errors carry stable code strings.
  const code =
    (err as AuthError | undefined)?.code ??
    (err as { code?: string } | undefined)?.code;
  switch (code) {
    case "auth/invalid-email":
      return "That email looks wrong.";
    case "auth/user-not-found":
    case "auth/wrong-password":
    case "auth/invalid-credential":
      return "Email or password didn't match our records.";
    case "auth/email-already-in-use":
      return "An account with that email already exists. Sign in instead.";
    case "auth/weak-password":
      return "Pick a stronger password (8+ characters).";
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
      return "Google sign-in was cancelled.";
    case "auth/popup-blocked":
      return "Your browser blocked the Google sign-in popup. Allow popups for this site and try again.";
    case "auth/network-request-failed":
      return "Network error reaching Firebase. Check your connection and try again.";
    case "auth/too-many-requests":
      return "Too many failed attempts. Wait a moment and try again.";
    default:
      return mode === "signup"
        ? "Could not create the account. Please try again."
        : "Could not sign in. Please try again.";
  }
}

function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 18 18" className={className} aria-hidden>
      <path
        fill="#4285F4"
        d="M17.64 9.205c0-.638-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.717v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.616z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"
      />
    </svg>
  );
}
