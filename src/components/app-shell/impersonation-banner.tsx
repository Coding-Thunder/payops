"use client";

import * as React from "react";
import { AlertTriangleIcon } from "lucide-react";

/**
 * Persistent, un-dismissable banner shown on every authed page while the
 * session is an impersonation. Loud on purpose — the operator must never
 * forget they're acting as someone else. "Exit" ends the impersonation
 * session and returns to the login page (the operator re-enters from the
 * console). Observe-only mode is called out explicitly.
 */
export function ImpersonationBanner({
  name,
  email,
  by,
  observeOnly,
}: {
  name: string;
  email: string;
  by: string;
  observeOnly: boolean;
}) {
  const [busy, setBusy] = React.useState(false);

  async function exit() {
    setBusy(true);
    try {
      await fetch("/api/impersonate/exit", { method: "POST" });
    } catch {
      /* fall through to redirect regardless */
    } finally {
      window.location.href = "/login";
    }
  }

  return (
    <div className="sticky top-0 z-[60] flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-amber-500 px-4 py-1.5 text-center text-[12.5px] font-medium text-amber-950">
      <AlertTriangleIcon className="size-3.5" aria-hidden />
      <span>
        Impersonating <strong>{name}</strong>{" "}
        <span className="opacity-80">({email})</span> · started by {by} ·{" "}
        <strong>{observeOnly ? "read-only" : "full access"}</strong>
      </span>
      <button
        onClick={exit}
        disabled={busy}
        className="rounded bg-amber-950/90 px-2 py-0.5 text-[12px] font-semibold text-amber-50 hover:bg-amber-950 disabled:opacity-50"
      >
        {busy ? "Exiting…" : "Exit impersonation"}
      </button>
    </div>
  );
}
