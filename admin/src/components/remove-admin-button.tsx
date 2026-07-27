"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

export function RemoveAdminButton({
  id,
  email,
}: {
  id: string;
  email: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);

  async function remove() {
    if (busy) return;
    if (!confirm(`Remove admin access for ${email}?`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admins/${id}`, { method: "DELETE" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.ok === false) {
        throw new Error(json?.error?.message ?? "Couldn't remove admin");
      }
      router.refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Couldn't remove admin");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={remove}
      disabled={busy}
      className="rounded-md border border-red-500/30 px-2.5 py-1 text-[12px] text-red-300 hover:bg-red-500/10 disabled:opacity-50"
    >
      {busy ? "Removing…" : "Remove"}
    </button>
  );
}
