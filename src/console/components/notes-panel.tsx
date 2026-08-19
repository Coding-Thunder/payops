"use client";

import * as React from "react";
import { ADMIN_API } from "@/console/lib/paths";
import { useConfirm } from "@/console/components/confirm-dialog";

export interface Note {
  id: string;
  body: string;
  authorEmail: string;
  createdAt: string | null;
}

function fmt(iso: string | null): string {
  if (!iso) return "";
  // Fixed locale + pinned timezone → identical server/client text (no #418).
  return new Date(iso).toLocaleString("en-US", {
    timeZone: process.env.NEXT_PUBLIC_DISPLAY_TIMEZONE || "UTC",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Internal ops notes for one entity. Append + delete only. Optimistically
 * updates local state on success (the server is the source of truth on
 * reload). Embeddable on any detail page via subjectType/subjectId.
 */
export function NotesPanel({
  subjectType,
  subjectId,
  initialNotes,
}: {
  subjectType: string;
  subjectId: string;
  initialNotes: Note[];
}) {
  const [notes, setNotes] = React.useState<Note[]>(initialNotes);
  const [body, setBody] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const { confirm, dialog } = useConfirm();

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = body.trim();
    if (!trimmed) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`${ADMIN_API}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subjectType, subjectId, body: trimmed }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.data?.note) {
        setErr(data?.error?.message ?? "Could not add note");
        return;
      }
      setNotes((prev) => [data.data.note as Note, ...prev]);
      setBody("");
    } catch {
      setErr("Network error");
    } finally {
      setBusy(false);
    }
  }

  function remove(id: string) {
    confirm(
      {
        title: "Delete this note?",
        body: "Notes are append-only for everyone else — deleting removes it for good.",
        confirmLabel: "Delete note",
        tone: "danger",
      },
      async () => {
        const res = await fetch(`${ADMIN_API}/notes/${id}/delete`, {
          method: "POST",
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || json?.ok === false) {
          throw new Error(json?.error?.message ?? "Could not delete the note");
        }
        setNotes((prev) => prev.filter((n) => n.id !== id));
      },
    );
  }

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4">
      <h2 className="mb-3 text-sm font-semibold text-slate-200">
        Internal notes
      </h2>

      <form onSubmit={add} className="space-y-2">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Add an ops note…"
          rows={2}
          className="w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-sm text-slate-100 outline-none focus:border-[var(--accent)]"
        />
        <div className="flex items-center gap-2">
          <button
            disabled={busy || !body.trim()}
            className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-slate-200 hover:bg-white/5 disabled:opacity-50"
          >
            {busy ? "Saving…" : "Add note"}
          </button>
          {err ? <span className="text-[12px] text-red-400">{err}</span> : null}
        </div>
      </form>

      <ul className="mt-4 space-y-3">
        {notes.length === 0 ? (
          <li className="text-[13px] text-[var(--muted)]">No notes yet.</li>
        ) : (
          notes.map((n) => (
            <li
              key={n.id}
              className="rounded-lg border border-[var(--border)]/60 bg-[var(--panel-2)]/40 p-3"
            >
              <p className="whitespace-pre-wrap text-[13px] text-slate-200">
                {n.body}
              </p>
              <div className="mt-1.5 flex items-center justify-between text-[11px] text-[var(--muted)]">
                <span>
                  {n.authorEmail} · {fmt(n.createdAt)}
                </span>
                <button
                  onClick={() => remove(n.id)}
                  className="text-red-300/80 hover:text-red-300"
                >
                  Delete
                </button>
              </div>
            </li>
          ))
        )}
      </ul>
      {dialog}
    </div>
  );
}
