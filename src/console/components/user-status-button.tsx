"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ADMIN_API } from "@/console/lib/paths";
import { useConfirm } from "@/console/components/confirm-dialog";

export function UserStatusButton({
  userId,
  status,
}: {
  userId: string;
  status: string;
}) {
  const router = useRouter();
  const { confirm, dialog, busy } = useConfirm();
  const isActive = status === "ACTIVE";
  const next = isActive ? "DISABLED" : "ACTIVE";

  async function apply() {
    const res = await fetch(`${ADMIN_API}/users/${userId}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json?.ok === false) {
      throw new Error(json?.error?.message ?? "Could not update user status.");
    }
    router.refresh();
  }

  function toggle() {
    if (busy) return;
    // Enabling is not destructive, so it does not need a confirmation step.
    if (!isActive) {
      void apply().catch(() => {});
      return;
    }
    confirm(
      {
        title: "Disable this user?",
        body: "They will be signed out and won't be able to sign in again until re-enabled. Their data and orders are untouched.",
        confirmLabel: "Disable user",
        tone: "danger",
      },
      apply,
    );
  }

  // Only ACTIVE/DISABLED are togglable; ARCHIVED is read-only.
  if (status !== "ACTIVE" && status !== "DISABLED") {
    return <span className="text-[12px] text-[var(--muted)]">—</span>;
  }

  return (
    <>
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
      {dialog}
    </>
  );
}
