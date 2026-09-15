"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { useConfirm } from "@/console/components/confirm-dialog";
import { ADMIN_API } from "@/console/lib/paths";

/**
 * Approve / reject / un-publish / note actions for one review.
 *
 * There is no "edit" control, because there is no endpoint behind it. A
 * moderator publishes a review as written or does not publish it — see the
 * reasoning in `@/console/server/services/reviews`.
 */
export function ReviewActions({
  id,
  status,
  note: initialNote,
}: {
  id: string;
  status: string;
  note: string;
}) {
  const router = useRouter();
  const { confirm, dialog } = useConfirm();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [note, setNote] = React.useState(initialNote);
  const [savedNote, setSavedNote] = React.useState(initialNote);
  const [error, setError] = React.useState<string | null>(null);

  async function call(action: string, body?: unknown) {
    if (busy) return null;
    setBusy(action);
    setError(null);
    try {
      const res = await fetch(`${ADMIN_API}/reviews/${id}?action=${action}`, {
        method: "POST",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.ok === false) {
        throw new Error(json?.error?.message ?? "Action failed");
      }
      router.refresh();
      return json;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
      return null;
    } finally {
      setBusy(null);
    }
  }

  const approve = () =>
    confirm(
      {
        title: "Publish this review?",
        body: "It appears on /reviews exactly as written, under the reviewer's name, and counts toward the public rating.",
        confirmLabel: "Publish",
      },
      async () => {
        await call("approve");
      },
    );

  const reject = () =>
    confirm(
      {
        title: "Reject this review?",
        body: "It stays on record with your name against the decision, and never becomes public. Add a note first if the reason isn't obvious.",
        confirmLabel: "Reject",
        tone: "danger",
      },
      async () => {
        await call("reject", { note });
      },
    );

  const unapprove = () =>
    confirm(
      {
        title: "Take this review down?",
        body: "It disappears from /reviews and stops counting toward the rating. It returns to the queue rather than being deleted.",
        confirmLabel: "Take down",
      },
      async () => {
        await call("unapprove");
      },
    );

  const saveNote = async () => {
    const res = await call("note", { note });
    if (res) setSavedNote(note);
  };

  return (
    <div className="space-y-4">
      {dialog}

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-[13px] text-red-200"
        >
          {error}
        </div>
      ) : null}

      <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4">
        <label
          htmlFor="rv-note"
          className="text-[11px] uppercase tracking-wider text-[var(--muted)]"
        >
          Internal note (never public)
        </label>
        <textarea
          id="rv-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          maxLength={2000}
          className="mt-2 w-full rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-sm text-slate-100 outline-none focus:border-[var(--accent)]"
        />
        <button
          onClick={saveNote}
          disabled={busy === "note" || note === savedNote}
          className="mt-2 rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-slate-200 hover:bg-white/5 disabled:opacity-50"
        >
          {busy === "note" ? "Saving…" : note === savedNote ? "Saved" : "Save note"}
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        {status !== "APPROVED" ? (
          <button
            onClick={approve}
            disabled={Boolean(busy)}
            className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-50"
          >
            Publish as written
          </button>
        ) : (
          <button
            onClick={unapprove}
            disabled={Boolean(busy)}
            className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm text-amber-200 hover:bg-amber-500/20 disabled:opacity-50"
          >
            Take down
          </button>
        )}
        {status !== "REJECTED" ? (
          <button
            onClick={reject}
            disabled={Boolean(busy)}
            className="rounded-lg border border-red-500/40 px-4 py-2 text-sm text-red-300 hover:bg-red-500/10 disabled:opacity-50"
          >
            Reject
          </button>
        ) : null}
      </div>
    </div>
  );
}
