import * as React from "react";

/** Shared, server-renderable presentational primitives. */

export function StatTile({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: "default" | "good" | "warn" | "bad" | "muted";
}) {
  const color =
    tone === "good"
      ? "text-emerald-400"
      : tone === "warn"
        ? "text-amber-400"
        : tone === "bad"
          ? "text-red-400"
          : tone === "muted"
            ? "text-slate-500"
            : "text-slate-100";
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4">
      <div className="text-[11px] uppercase tracking-wider text-[var(--muted)]">
        {label}
      </div>
      <div className={`mt-1 text-2xl font-semibold ${color}`}>{value}</div>
      {hint ? (
        <div className="mt-1 text-[11px] text-[var(--muted)]">{hint}</div>
      ) : null}
    </div>
  );
}

export function Card({
  title,
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4">
      {title ? (
        <h2 className="mb-3 text-sm font-semibold text-slate-200">{title}</h2>
      ) : null}
      {children}
    </div>
  );
}

export function Badge({
  children,
  tone = "default",
}: {
  children: React.ReactNode;
  tone?: "good" | "warn" | "bad" | "default";
}) {
  const cls =
    tone === "good"
      ? "bg-emerald-500/15 text-emerald-300"
      : tone === "warn"
        ? "bg-amber-500/15 text-amber-300"
        : tone === "bad"
          ? "bg-red-500/15 text-red-300"
          : "bg-slate-500/15 text-slate-300";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${cls}`}
    >
      {children}
    </span>
  );
}

export function Pagination({
  page,
  totalPages,
  total,
  hrefForPage,
}: {
  page: number;
  totalPages: number;
  total: number;
  hrefForPage: (page: number) => string;
}) {
  const prev = Math.max(1, page - 1);
  const next = Math.min(totalPages, page + 1);
  const linkCls =
    "rounded-md border border-[var(--border)] px-3 py-1.5 text-sm text-slate-200 hover:bg-white/5";
  const disabledCls =
    "rounded-md border border-[var(--border)] px-3 py-1.5 text-sm text-slate-600 pointer-events-none";
  return (
    <div className="flex items-center justify-between pt-3">
      <span className="text-[12px] text-[var(--muted)]">
        Page {page} of {totalPages} · {total} total
      </span>
      <div className="flex gap-2">
        <a className={page <= 1 ? disabledCls : linkCls} href={hrefForPage(prev)}>
          ← Prev
        </a>
        <a
          className={page >= totalPages ? disabledCls : linkCls}
          href={hrefForPage(next)}
        >
          Next →
        </a>
      </div>
    </div>
  );
}

export function Field({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-[var(--muted)]">
        {label}
      </div>
      <div className="mt-0.5 text-sm text-slate-200">{value}</div>
    </div>
  );
}

export function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="border-b border-[var(--border)] px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-[var(--muted)]">
      {children}
    </th>
  );
}

export function Td({ children }: { children: React.ReactNode }) {
  return (
    <td className="border-b border-[var(--border)]/60 px-3 py-2 text-sm text-slate-200">
      {children}
    </td>
  );
}

// Pinned display timezone + fixed locale so the server (UTC) and the browser
// render IDENTICAL text — otherwise every date hydrates with a mismatch
// (#418). Override with NEXT_PUBLIC_DISPLAY_TIMEZONE (e.g. "Asia/Kolkata").
export const DISPLAY_TIMEZONE =
  process.env.NEXT_PUBLIC_DISPLAY_TIMEZONE || "UTC";

export function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    timeZone: DISPLAY_TIMEZONE,
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    timeZone: DISPLAY_TIMEZONE,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
