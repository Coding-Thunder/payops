"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

const inputCls =
  "rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-3 py-1.5 text-sm text-slate-100 outline-none focus:border-[var(--accent)]";

export function AddAdminForm() {
  const router = useRouter();
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<"ADMIN" | "OWNER">("ADMIN");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [ok, setOk] = React.useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setOk(null);
    if (!name.trim() || !email.trim()) {
      setError("Name and email are required.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/admins", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), email: email.trim(), role }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.ok === false) {
        throw new Error(json?.error?.message ?? "Couldn't add admin");
      }
      setOk(`Added ${email.trim()} — a welcome email is on its way.`);
      setName("");
      setEmail("");
      setRole("ADMIN");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add admin");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4"
    >
      <div className="text-sm font-medium text-slate-100">Add an admin</div>
      <div className="mt-1 text-[12px] text-[var(--muted)]">
        They&apos;ll get a welcome email and can sign in with a one-time code.
      </div>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Full name"
          className={`${inputCls} sm:w-48`}
          autoComplete="off"
        />
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="email@company.com"
          type="email"
          inputMode="email"
          className={`${inputCls} flex-1`}
          autoComplete="off"
        />
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as "ADMIN" | "OWNER")}
          className={`${inputCls} sm:w-36`}
        >
          <option value="ADMIN">Admin</option>
          <option value="OWNER">Owner</option>
        </select>
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg border border-[var(--accent)] bg-[var(--accent)]/10 px-4 py-1.5 text-sm text-[var(--accent)] hover:bg-[var(--accent)]/20 disabled:opacity-50"
        >
          {busy ? "Adding…" : "Add admin"}
        </button>
      </div>
      {error ? (
        <p className="mt-2 text-[12px] text-red-300">{error}</p>
      ) : null}
      {ok ? <p className="mt-2 text-[12px] text-emerald-300">{ok}</p> : null}
    </form>
  );
}
