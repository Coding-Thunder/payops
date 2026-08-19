"use client";

import * as React from "react";
import { ADMIN_API } from "@/console/lib/paths";
import { useConfirm } from "@/console/components/confirm-dialog";

/**
 * Support actions on a main-app user. Each triggers an existing main-app
 * flow via a guarded, audited API route. Impersonation hands off to the
 * main app (which mints a short-TTL, observe-only, banner-flagged, audited
 * session). Resend-verification/unlock require further main-app endpoints.
 */
export function UserSupportActions({ userId }: { userId: string }) {
  const [busy, setBusy] = React.useState<null | "reset" | "impersonate">(null);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const { confirm, dialog } = useConfirm();

  function sendReset() {
    confirm(
      {
        title: "Email a password-reset link?",
        body: "The user receives a single-use link that lets them set a new password. Their current password keeps working until they use it.",
        confirmLabel: "Send reset link",
      },
      doSendReset,
    );
  }

  async function doSendReset() {
    setBusy("reset");
    setMsg(null);
    try {
      const res = await fetch(`${ADMIN_API}/users/${userId}/reset-password`, {
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
      setBusy(null);
    }
  }

  function impersonate() {
    confirm(
      {
        title: "Impersonate this user?",
        body: "You will be signed in as them in READ-ONLY mode — every mutation is blocked at the edge. The session lasts 30 minutes and is written to the audit trail against your name.",
        confirmLabel: "Start read-only session",
        tone: "danger",
      },
      doImpersonate,
    );
  }

  async function doImpersonate() {
    setBusy("impersonate");
    setMsg(null);
    try {
      const res = await fetch(`${ADMIN_API}/support/impersonate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body?.data?.url) {
        setMsg({
          ok: false,
          text: body?.error?.message ?? "Could not start impersonation",
        });
        return;
      }
      // Cross-origin full navigation to the main app's single-use handoff.
      window.location.href = body.data.url as string;
    } catch {
      setMsg({ ok: false, text: "Network error" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        onClick={sendReset}
        disabled={busy !== null}
        className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-slate-200 hover:bg-white/5 disabled:opacity-50"
      >
        {busy === "reset" ? "Sending…" : "Send password-reset link"}
      </button>
      <button
        onClick={impersonate}
        disabled={busy !== null}
        className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-sm text-amber-300 hover:bg-amber-500/20 disabled:opacity-50"
      >
        {busy === "impersonate" ? "Starting…" : "Impersonate (read-only)"}
      </button>
      {msg ? (
        <span
          className={`text-[12px] ${msg.ok ? "text-emerald-300" : "text-red-300"}`}
        >
          {msg.text}
        </span>
      ) : null}
      {dialog}
    </div>
  );
}
