"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  type AuthError,
} from "firebase/auth";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadingButton } from "@/components/ui/loading-button";
import { api, ApiClientError } from "@/lib/api-client";
import { getFirebaseAuth, isFirebaseConfigured } from "@/lib/firebase/client";

/**
 * Firebase-backed email + password form for sign-in / sign-up.
 *
 * Google OAuth was removed pending sorted-out API-key referer
 * restrictions in GCP. If we re-introduce social sign-in later, add
 * the button + handler back here and re-import GoogleAuthProvider /
 * signInWithPopup from firebase/auth.
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
  const [busy, setBusy] = useState(false);
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
    setBusy(true);
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
      setBusy(false);
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

      <form className="space-y-4" onSubmit={handleEmailSubmit} noValidate>
        <div className="space-y-1.5">
          <Label htmlFor="fb-email">Work email</Label>
          <Input
            id="fb-email"
            type="email"
            autoComplete="email"
            inputMode="email"
            placeholder="you@company.com"
            disabled={busy}
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
            disabled={busy}
            required
            minLength={mode === "signup" ? 8 : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        <LoadingButton
          type="submit"
          className="w-full"
          loading={busy}
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
    case "auth/network-request-failed":
      return "Network error reaching Firebase. Check your connection and try again.";
    case "auth/too-many-requests":
      return "Too many failed attempts. Wait a moment and try again.";
    case "auth/unauthorized-domain":
      return "This domain is not authorized in the Firebase project. Add it to Authentication → Settings → Authorized domains.";
    case "auth/operation-not-allowed":
      return "Email/Password sign-in is not enabled in the Firebase project. Enable it under Authentication → Sign-in method.";
    case "auth/internal-error":
      return "Firebase internal error. Check the Firebase project configuration and try again.";
    default: {
      const verb = mode === "signup" ? "create the account" : "sign in";
      return code
        ? `Could not ${verb} (${code}). Check the Firebase project configuration.`
        : `Could not ${verb}. Please try again.`;
    }
  }
}
