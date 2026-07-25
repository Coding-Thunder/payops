"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

export function GrantButton({
  quotationId,
  granted,
  email,
}: {
  quotationId: string;
  granted: boolean;
  email: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState(granted);

  async function grant() {
    if (busy || done) return;
    if (!confirm(`Provision an account for ${email} and email a set-password link?`)) {
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/waitlist/${quotationId}/grant`, {
        method: "POST",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.ok === false) {
        throw new Error(json?.error?.message ?? "Grant failed");
      }
      setDone(true);
      router.refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Grant failed");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <span className="rounded-md border border-emerald-500/30 px-2.5 py-1 text-[12px] text-emerald-300">
        Granted
      </span>
    );
  }

  return (
    <button
      onClick={grant}
      disabled={busy}
      className="rounded-md border border-[var(--accent)] bg-[var(--accent)]/10 px-2.5 py-1 text-[12px] text-[var(--accent)] hover:bg-[var(--accent)]/20 disabled:opacity-50"
    >
      {busy ? "Granting…" : "Grant access"}
    </button>
  );
}
