"use client";

import * as React from "react";
import { usePathname } from "next/navigation";

export function TopNav({
  email,
  pendingBeta = 0,
}: {
  email: string;
  pendingBeta?: number;
}) {
  const pathname = usePathname();
  const [busy, setBusy] = React.useState(false);

  async function logout() {
    setBusy(true);
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/";
  }

  const links = [
    { href: "/dashboard", label: "Dashboard", count: 0 },
    { href: "/beta-applications", label: "Beta", count: pendingBeta },
    { href: "/users", label: "Users", count: 0 },
    { href: "/waitlist", label: "Waitlist", count: 0 },
    { href: "/customers", label: "Customers", count: 0 },
    { href: "/orders", label: "Orders", count: 0 },
    { href: "/emails", label: "Email Ops", count: 0 },
    { href: "/audit", label: "Audit", count: 0 },
    { href: "/admins", label: "Admins", count: 0 },
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
                  className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm ${
                    active
                      ? "bg-white/10 text-slate-100"
                      : "text-[var(--muted)] hover:text-slate-200"
                  }`}
                >
                  {l.label}
                  {l.count > 0 ? (
                    <span className="inline-flex min-w-[18px] items-center justify-center rounded-full bg-amber-500/20 px-1.5 text-[11px] font-semibold text-amber-300">
                      {l.count}
                    </span>
                  ) : null}
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
