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
import { TurnstileWidget } from "@/components/common/turnstile-widget";
import { api, ApiClientError } from "@/lib/api-client";
import { getFirebaseAuth, isFirebaseConfigured } from "@/lib/firebase/client";

/**
 * Firebase-backed sign-in + sign-up form.
 *
 * Two paths: Google OAuth (popup) and email + password. Both go
 * through the same /api/auth/firebase-session exchange so downstream
 * session machinery (JWT cookie, RBAC, audit) doesn't care which the
 * user picked. Mode is set by the caller — "signup" creates a fresh
 * Firebase user + provisions a TraceTxn workspace on first exchange,
 * "signin" only authenticates existing accounts.
 */

interface FirebaseAuthFormProps {
  mode: "signin" | "signup";
  nextPath?: string;
  /** Cloudflare Turnstile site key. When provided the widget renders
   *  and submit is gated on a verified token; when null/undefined the
   *  widget is omitted entirely (matches the legacy LoginForm contract).
   *  Token is also forwarded to /api/auth/firebase-session for server-
   *  side re-verification so client tampering can't bypass the check. */
  turnstileSiteKey?: string | null;
}

interface FirebaseSessionResponse {
  user: { id: string; name: string; email: string; role: string };
  isNewUser: boolean;
  orgId: string | null;
}

export function FirebaseAuthForm({
  mode,
  nextPath,
  turnstileSiteKey,
}: FirebaseAuthFormProps) {
  const router = useRouter();
  const configured = isFirebaseConfigured();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<null | "email" | "google">(null);
  const [error, setError] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<string | null>(null);
  const [cfToken, setCfToken] = useState<string | null>(null);

  const requiresToken = Boolean(turnstileSiteKey);
  const captchaReady = !requiresToken || Boolean(cfToken);

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
    try {
      await api.post<FirebaseSessionResponse>(
        "/api/auth/firebase-session",
        // Turnstile token is single-use, so we always clear it after the
        // attempt regardless of outcome (see the catch/finally below).
        { idToken, cfToken: cfToken ?? undefined },
      );
      router.replace(safeNext(nextPath));
      router.refresh();
    } finally {
      setCfToken(null);
    }
  }

  function captchaGate(): boolean {
    if (requiresToken && !cfToken) {
      setError("Please complete the verification challenge first.");
      return false;
    }
    return true;
  }

  async function handleEmailSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!captchaGate()) return;
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
      setErrorDetails(dumpErrorForUi(err));
    } finally {
      setBusy(null);
    }
  }

  async function handleGoogle() {
    setError(null);
    if (!captchaGate()) return;
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
      setErrorDetails(dumpErrorForUi(err));
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
          <AlertDescription>
            <div>{error}</div>
            {errorDetails ? (
              <pre className="mt-3 max-h-64 overflow-auto rounded bg-black/20 p-2 text-[10px] leading-snug whitespace-pre-wrap break-all font-mono">
                {errorDetails}
              </pre>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      <Button
        type="button"
        variant="outline"
        className="w-full gap-2 h-10"
        onClick={handleGoogle}
        disabled={busy !== null || !captchaReady}
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

        {requiresToken ? (
          <TurnstileWidget
            siteKey={turnstileSiteKey}
            onVerify={(t) => setCfToken(t)}
            onExpire={() => setCfToken(null)}
            onError={() => setCfToken(null)}
            className="flex justify-center"
          />
        ) : null}

        <LoadingButton
          type="submit"
          className="w-full"
          loading={busy === "email"}
          loadingText={mode === "signup" ? "Creating account" : "Signing in"}
          disabled={!captchaReady}
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

/** Renders every interesting field of a caught error as a single
 *  inspectable string. Goal: never need DevTools to debug a failed
 *  auth attempt — the whole payload appears under the inline alert. */
function dumpErrorForUi(err: unknown): string {
  const e = err as {
    name?: string;
    code?: string;
    message?: string;
    customData?: unknown;
    stack?: string;
  } | null;
  if (!e) return "(no error object)";
  return [
    `name:    ${e.name ?? "(unknown)"}`,
    `code:    ${e.code ?? "(no code)"}`,
    `message: ${e.message ?? "(no message)"}`,
    `customData: ${safeStringify(e.customData)}`,
    `stack:\n${e.stack ?? "(no stack)"}`,
  ].join("\n");
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "(undefined)";
  } catch (err) {
    return `(unstringifiable: ${err instanceof Error ? err.message : String(err)})`;
  }
}

function humanizeAuthError(err: unknown, mode: "signin" | "signup"): string {
  // Log the full error to the console so DevTools shows everything —
  // stack, message, code, customData. The on-screen string is a
  // summary; the console is the source of truth.
   
  console.error("[firebase-auth-form] caught:", err);

  // Server-side exchange error (after Firebase succeeded).
  if (err instanceof ApiClientError) return err.message;
  // Firebase Auth errors carry stable code strings AND, for many
  // failures, the raw Identity Toolkit JSON payload at
  // err.customData.serverResponse — the most useful diagnostic field.
  const code =
    (err as AuthError | undefined)?.code ??
    (err as { code?: string } | undefined)?.code;
  const serverResponse = (
    err as { customData?: { serverResponse?: unknown } } | undefined
  )?.customData?.serverResponse;
  const serverHint = serverResponse
    ? ` · server: ${JSON.stringify(serverResponse).slice(0, 220)}`
    : "";
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
    case "auth/unauthorized-domain":
      return "This domain is not authorized in the Firebase project. Add it to Authentication → Settings → Authorized domains.";
    case "auth/operation-not-allowed":
      return "This sign-in method is not enabled in the Firebase project. Enable it under Authentication → Sign-in method.";
    case "auth/account-exists-with-different-credential":
      return "An account already exists with this email but a different sign-in method. Use that method instead.";
    case "auth/internal-error":
      return `Firebase internal error.${serverHint || " Open DevTools console for the full payload."}`;
    default: {
      const verb = mode === "signup" ? "create the account" : "sign in";
      const base = code
        ? `Could not ${verb} (${code}).`
        : `Could not ${verb}.`;
      return `${base}${serverHint}`;
    }
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
