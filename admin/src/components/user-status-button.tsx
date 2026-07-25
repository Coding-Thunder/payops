"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

export function UserStatusButton({
  userId,
  status,
}: {
  userId: string;
  status: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const isActive = status === "ACTIVE";
  const next = isActive ? "DISABLED" : "ACTIVE";

  async function toggle() {
    if (busy) return;
    if (isActive && !confirm("Disable this user? They won't be able to sign in.")) {
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/users/${userId}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) throw new Error("Failed");
      router.refresh();
    } catch {
      alert("Could not update user status.");
    } finally {
      setBusy(false);
    }
  }

  // Only ACTIVE/DISABLED are togglable; ARCHIVED is read-only.
  if (status !== "ACTIVE" && status !== "DISABLED") {
    return <span className="text-[12px] text-[var(--muted)]">—</span>;
  }

  return (
    <button
      onClick={toggle}
      disabled={busy}
      className={`rounded-md border px-2.5 py-1 text-[12px] disabled:opacity-50 ${
        isActive
          ? "border-red-500/30 text-red-300 hover:bg-red-500/10"
          : "border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/10"
      }`}
    >
      {busy ? "…" : isActive ? "Disable" : "Enable"}
    </button>
  );
}
