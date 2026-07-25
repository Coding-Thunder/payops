"use client";

import * as React from "react";
import { usePathname } from "next/navigation";

export function TopNav({ email }: { email: string }) {
  const pathname = usePathname();
  const [busy, setBusy] = React.useState(false);

  async function logout() {
    setBusy(true);
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/";
  }

  const links = [
    { href: "/dashboard", label: "Dashboard" },
    { href: "/users", label: "Users" },
    { href: "/waitlist", label: "Waitlist" },
  ];

  return (
    <header className="border-b border-[var(--border)] bg-[var(--panel-2)]">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
        <div className="flex items-center gap-6">
          <span className="text-sm font-semibold text-slate-100">
            TraceTxn Admin
          </span>
          <nav className="flex gap-1">
            {links.map((l) => {
              const active =
                pathname === l.href || pathname.startsWith(`${l.href}/`);
              return (
                <a
                  key={l.href}
                  href={l.href}
                  className={`rounded-md px-3 py-1.5 text-sm ${
                    active
                      ? "bg-white/10 text-slate-100"
                      : "text-[var(--muted)] hover:text-slate-200"
                  }`}
                >
                  {l.label}
                </a>
              );
            })}
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden text-[12px] text-[var(--muted)] sm:inline">
            {email}
          </span>
          <button
            onClick={logout}
            disabled={busy}
            className="rounded-md border border-[var(--border)] px-3 py-1.5 text-[13px] text-slate-200 hover:bg-white/5 disabled:opacity-50"
          >
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}
