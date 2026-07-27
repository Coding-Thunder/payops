"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

/**
 * Approve / Reject / retry-invite / internal-note actions for a beta
 * application. Every action posts to an admin-auth-gated endpoint; the UI
 * only decides which buttons to show, never the authorization.
 */
export function BetaActions({
  id,
  status,
  note: initialNote,
}: {
  id: string;
  status: string;
  note: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<null | string>(null);
  const [note, setNote] = React.useState(initialNote);
  const [savedNote, setSavedNote] = React.useState(initialNote);

  async function call(action: string, path: string, body?: unknown) {
    if (busy) return;
    setBusy(action);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.ok === false) {
        throw new Error(json?.error?.message ?? "Action failed");
      }
      // Approve may succeed at the DB but fail to email — surface that.
      if (json?.data && json.data.emailed === false) {
        alert(
          `Approved, but the invitation email failed to send: ${
            json.data.error ?? "unknown error"
          }. You can retry from this page.`,
        );
      }
      router.refresh();
      return json;
    } catch (err) {
      alert(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(null);
    }
  }

  const approve = () =>
    call("approve", `/api/beta-applications/${id}/approve`);
  const reject = () => {
    if (!confirm("Reject this application? They will not get access.")) return;
    call("reject", `/api/beta-applications/${id}/reject`, {
      note: note.trim() || undefined,
    });
  };
  const saveNote = async () => {
    const res = await call("note", `/api/beta-applications/${id}/note`, {
      note,
    });
    if (res) setSavedNote(note);
  };

  const btn =
    "rounded-md border px-3 py-1.5 text-[13px] disabled:opacity-50";

  return (
    <div className="space-y-4 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4">
      <div className="text-sm font-medium text-slate-100">Review</div>

      <div className="flex flex-wrap gap-2">
        {status === "PENDING" ? (
          <button
            onClick={approve}
            disabled={!!busy}
            className={`${btn} border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20`}
          >
            {busy === "approve" ? "Sending…" : "Approve & send invitation"}
          </button>
        ) : null}

        {status === "APPROVED" ? (
          <button
            onClick={approve}
            disabled={!!busy}
            className={`${btn} border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20`}
          >
            {busy === "approve" ? "Sending…" : "Retry invitation"}
          </button>
        ) : null}

        {status === "INVITED" ? (
          <button
            onClick={approve}
            disabled={!!busy}
            className={`${btn} border-[var(--border)] text-slate-200 hover:bg-white/5`}
          >
            {busy === "approve" ? "Sending…" : "Resend invitation"}
          </button>
        ) : null}

        {status !== "ACTIVATED" && status !== "REJECTED" ? (
          <button
            onClick={reject}
            disabled={!!busy}
            className={`${btn} border-red-500/40 text-red-300 hover:bg-red-500/10`}
          >
            {busy === "reject" ? "Rejecting…" : "Reject"}
          </button>
        ) : null}
      </div>

      <div>
        <label className="text-[11px] uppercase tracking-wider text-[var(--muted)]">
          Internal note
        </label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          maxLength={4000}
          placeholder="Only visible to admins."
          className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-sm text-slate-100 outline-none focus:border-[var(--accent)]"
        />
        <button
          onClick={saveNote}
          disabled={!!busy || note === savedNote}
          className={`${btn} mt-2 border-[var(--border)] text-slate-200 hover:bg-white/5`}
        >
          {busy === "note" ? "Saving…" : "Save note"}
        </button>
      </div>
    </div>
  );
}
