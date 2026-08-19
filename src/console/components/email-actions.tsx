"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ADMIN_API } from "@/console/lib/paths";
import { useConfirm } from "@/console/components/confirm-dialog";

type Action = "retry" | "cancel" | "resend";

/**
 * Retry / Resend / Cancel controls for a queued email. Which buttons show
 * depends on the row's status; the server re-checks validity regardless.
 * On success we router.refresh() so the list/detail reflects the new state.
 */
export function EmailActions({
  id,
  status,
}: {
  id: string;
  status: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<Action | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const { confirm, dialog } = useConfirm();

  function run(action: Action) {
    if (action !== "cancel") {
      void doRun(action);
      return;
    }
    confirm(
      {
        title: "Cancel this email?",
        body: "It is removed from the outbox and will never be sent. This cannot be undone.",
        confirmLabel: "Cancel email",
        tone: "danger",
      },
      () => doRun(action),
    );
  }

  async function doRun(action: Action) {
    setBusy(action);
    setErr(null);
    try {
      const res = await fetch(`${ADMIN_API}/emails/${id}/${action}`, {
        method: "POST",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body?.ok) {
        setErr(body?.error?.message ?? "Action failed");
        return;
      }
      router.refresh();
    } catch {
      setErr("Network error");
    } finally {
      setBusy(null);
    }
  }

  // Only FAILED shows Retry: re-queuing a PROCESSING (in-flight) row would
  // duplicate the send, and PENDING is already queued. Stuck-PROCESSING
  // recovery is handled server-side behind a staleness window.
  const canRetry = status === "FAILED";
  const canResend = status === "SENT" || status === "FAILED";
  const canCancel = status === "PENDING" || status === "FAILED";

  const btn =
    "rounded-md border border-[var(--border)] px-2 py-1 text-[12px] hover:bg-white/5 disabled:opacity-50";

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {canRetry && (
        <button
          className={`${btn} text-emerald-300`}
          disabled={busy !== null}
          onClick={() => run("retry")}
        >
          {busy === "retry" ? "…" : "Retry"}
        </button>
      )}
      {canResend && (
        <button
          className={`${btn} text-slate-200`}
          disabled={busy !== null}
          onClick={() => run("resend")}
        >
          {busy === "resend" ? "…" : "Resend"}
        </button>
      )}
      {canCancel && (
        <button
          className={`${btn} text-red-300`}
          disabled={busy !== null}
          onClick={() => run("cancel")}
        >
          {busy === "cancel" ? "…" : "Cancel"}
        </button>
      )}
      {err ? <span className="text-[11px] text-red-400">{err}</span> : null}
      {dialog}
    </div>
  );
}
