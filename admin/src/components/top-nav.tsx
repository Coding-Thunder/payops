"use client";

import * as React from "react";
import { usePathname } from "next/navigation";

interface Leaf {
  href: string;
  label: string;
  count?: number;
}
interface Group {
  label: string;
  children: Leaf[];
}
type NavItem = Leaf | Group;

function isGroup(item: NavItem): item is Group {
  return (item as Group).children !== undefined;
}

/**
 * Admin console nav. Two always-visible destinations (Dashboard + Beta, the
 * daily review queue with its pending badge) plus same-nature items grouped
 * under hoverable dropdowns so the header stays uncluttered. Dropdowns open on
 * hover AND on keyboard focus (focus-within), so they're reachable without a
 * mouse.
 */
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

  const items: NavItem[] = [
    { href: "/dashboard", label: "Dashboard" },
    { href: "/beta-applications", label: "Beta", count: pendingBeta },
    {
      label: "People",
      children: [
        { href: "/users", label: "Users" },
        { href: "/customers", label: "Customers" },
        { href: "/waitlist", label: "Waitlist" },
      ],
    },
    {
      label: "Operations",
      children: [
        { href: "/orders", label: "Orders" },
        { href: "/emails", label: "Email Ops" },
      ],
    },
    {
      label: "System",
      children: [
        { href: "/audit", label: "Audit" },
        { href: "/admins", label: "Admins" },
      ],
    },
  ];

  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`);

  const leafBase =
    "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm";
  const leafOn = "bg-white/10 text-slate-100";
  const leafOff = "text-[var(--muted)] hover:text-slate-200";

  function CountBadge({ count }: { count: number }) {
    if (count <= 0) return null;
    return (
      <span className="inline-flex min-w-[18px] items-center justify-center rounded-full bg-amber-500/20 px-1.5 text-[11px] font-semibold text-amber-300">
        {count}
      </span>
    );
  }

  return (
    <header className="border-b border-[var(--border)] bg-[var(--panel-2)]">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
        <div className="flex items-center gap-6">
          <span className="text-sm font-semibold text-slate-100">
            TraceTxn Admin
          </span>
          <nav className="flex items-center gap-1">
            {items.map((item) => {
              if (!isGroup(item)) {
                return (
                  <a
                    key={item.href}
                    href={item.href}
                    className={`${leafBase} ${
                      isActive(item.href) ? leafOn : leafOff
                    }`}
                  >
                    {item.label}
                    <CountBadge count={item.count ?? 0} />
                  </a>
                );
              }

              const groupActive = item.children.some((c) => isActive(c.href));
              const childCount = item.children.reduce(
                (n, c) => n + (c.count ?? 0),
                0,
              );
              return (
                <div key={item.label} className="group relative">
                  <button
                    type="button"
                    aria-haspopup="menu"
                    className={`${leafBase} ${
                      groupActive ? leafOn : leafOff
                    }`}
                  >
                    {item.label}
                    <CountBadge count={childCount} />
                    <svg
                      viewBox="0 0 12 12"
                      className="size-3 opacity-60"
                      aria-hidden
                    >
                      <path
                        d="M3 4.5 6 7.5 9 4.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                  {/* Menu sits flush under the trigger (top-full, no gap) so
                      the hover bridge doesn't break; also opens on keyboard
                      focus via group-focus-within. */}
                  <div
                    role="menu"
                    className="invisible absolute left-0 top-full z-50 min-w-[184px] translate-y-1 rounded-lg border border-[var(--border)] bg-[var(--panel-2)] p-1 opacity-0 shadow-xl transition duration-100 group-hover:visible group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:visible group-focus-within:translate-y-0 group-focus-within:opacity-100"
                  >
                    {item.children.map((c) => (
                      <a
                        key={c.href}
                        href={c.href}
                        role="menuitem"
                        className={`flex items-center justify-between gap-3 rounded-md px-3 py-1.5 text-sm ${
                          isActive(c.href)
                            ? "bg-white/10 text-slate-100"
                            : "text-[var(--muted)] hover:bg-white/5 hover:text-slate-200"
                        }`}
                      >
                        {c.label}
                        <CountBadge count={c.count ?? 0} />
                      </a>
                    ))}
                  </div>
                </div>
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
