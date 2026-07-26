"use client";

import * as React from "react";

/**
 * Support actions on a main-app user. Each triggers an existing main-app
 * flow via a guarded, audited API route. More actions (resend verification,
 * unlock) slot in here as they're built.
 */
export function UserSupportActions({ userId }: { userId: string }) {
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(
    null,
  );

  async function sendReset() {
    if (!window.confirm("Email a password-reset link to this user?")) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/users/${userId}/reset-password`, {
        method: "POST",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body?.ok) {
        setMsg({ ok: false, text: body?.error?.message ?? "Failed to send" });
        return;
      }
      setMsg({ ok: true, text: "Reset link sent." });
    } catch {
      setMsg({ ok: false, text: "Network error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        onClick={sendReset}
        disabled={busy}
        className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-slate-200 hover:bg-white/5 disabled:opacity-50"
      >
        {busy ? "Sending…" : "Send password-reset link"}
      </button>
      {msg ? (
        <span
          className={`text-[12px] ${msg.ok ? "text-emerald-300" : "text-red-300"}`}
        >
          {msg.text}
        </span>
      ) : null}
    </div>
  );
}
