"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { ADMIN_API } from "@/console/lib/paths";
import { useConfirm } from "@/console/components/confirm-dialog";

export function RemoveAdminButton({
  id,
  email,
}: {
  id: string;
  email: string;
}) {
  const router = useRouter();
  const { confirm, dialog, busy } = useConfirm();

  function ask() {
    confirm(
      {
        title: "Remove admin access?",
        body: (
          <>
            <strong className="text-slate-200">{email}</strong> will lose access
            to the console immediately, on their next request. Their audit
            history is kept.
          </>
        ),
        confirmLabel: "Remove access",
        tone: "danger",
      },
      // Errors thrown here surface inside the dialog instead of an alert(),
      // and the dialog stays open so the operator can retry or cancel.
      async () => {
        const res = await fetch(`${ADMIN_API}/admins/${id}`, {
          method: "DELETE",
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || json?.ok === false) {
          throw new Error(json?.error?.message ?? "Couldn't remove admin");
        }
        router.refresh();
      },
    );
  }

  return (
    <>
      <button
        onClick={ask}
        disabled={busy}
        className="rounded-md border border-red-500/30 px-2.5 py-1 text-[12px] text-red-300 hover:bg-red-500/10 disabled:opacity-50"
      >
        {busy ? "Removing…" : "Remove"}
      </button>
      {dialog}
    </>
  );
}
