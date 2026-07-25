"use client";

import * as React from "react";

import { googleSignInIdToken, isFirebaseConfigured } from "@/lib/firebase-client";

type Step = "start" | "otp";

async function postJson(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok && json?.ok !== false, data: json?.data, error: json?.error };
}

export function LoginForm() {
  const [step, setStep] = React.useState<Step>("start");
  const [email, setEmail] = React.useState("");
  const [code, setCode] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const googleReady = isFirebaseConfigured();

  async function requestEmailOtp(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await postJson("/api/auth/request-otp", { email });
      if (!r.ok) throw new Error(r.error?.message ?? "Could not send code");
      setNotice(`If ${email} is authorized, a 6-digit code is on its way.`);
      setStep("otp");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  async function signInGoogle() {
    setBusy(true);
    setError(null);
    try {
      const idToken = await googleSignInIdToken();
      const r = await postJson("/api/auth/google", { idToken });
      if (!r.ok) throw new Error(r.error?.message ?? "Google sign-in failed");
      setEmail(r.data.email);
      setNotice(`Code sent to ${r.data.email}.`);
      setStep("otp");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Google sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await postJson("/api/auth/verify-otp", { email, code });
      if (!r.ok) throw new Error(r.error?.message ?? "Invalid code");
      window.location.href = "/dashboard";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid code");
    } finally {
      setBusy(false);
    }
  }

  const inputCls =
    "w-full rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-sm text-slate-100 outline-none focus:border-[var(--accent)]";
  const btnCls =
    "w-full rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white hover:bg-[var(--accent-2)] disabled:opacity-50";

  return (
    <div className="w-full max-w-sm rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-6 shadow-xl">
      <h1 className="text-lg font-semibold text-slate-100">TraceTxn Admin</h1>
      <p className="mt-1 text-[13px] text-[var(--muted)]">
        Restricted console. Sign in with an authorized account.
      </p>

      {error ? (
        <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[13px] text-red-300">
          {error}
        </div>
      ) : null}
      {notice && step === "otp" ? (
        <div className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-[13px] text-slate-300">
          {notice}
        </div>
      ) : null}

      {step === "start" ? (
        <div className="mt-5 space-y-4">
          {googleReady ? (
            <>
              <button onClick={signInGoogle} disabled={busy} className={btnCls}>
                Continue with Google
              </button>
              <div className="flex items-center gap-3 text-[11px] text-[var(--muted)]">
                <div className="h-px flex-1 bg-[var(--border)]" />
                or
                <div className="h-px flex-1 bg-[var(--border)]" />
              </div>
            </>
          ) : null}
          <form onSubmit={requestEmailOtp} className="space-y-3">
            <input
              type="email"
              required
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputCls}
            />
            <button type="submit" disabled={busy} className={btnCls}>
              {busy ? "Sending…" : "Email me a code"}
            </button>
          </form>
        </div>
      ) : (
        <form onSubmit={verify} className="mt-5 space-y-3">
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            placeholder="123456"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            className={`${inputCls} tracking-[0.4em]`}
          />
          <button type="submit" disabled={busy || code.length !== 6} className={btnCls}>
            {busy ? "Verifying…" : "Verify & sign in"}
          </button>
          <button
            type="button"
            onClick={() => {
              setStep("start");
              setCode("");
              setError(null);
            }}
            className="w-full text-[12px] text-[var(--muted)] hover:text-slate-300"
          >
            ← Use a different account
          </button>
        </form>
      )}
    </div>
  );
}
