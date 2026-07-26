import Link from "next/link";

import {
  getEmailStats,
  listEmails,
  EMAIL_STATUSES,
} from "@/server/services/email-ops";
import { parsePagination } from "@/server/pagination";
import {
  Badge,
  Pagination,
  StatTile,
  Td,
  Th,
  fmtDateTime,
} from "@/components/ui";
import { EmailActions } from "@/components/email-actions";

export const dynamic = "force-dynamic";

// Known EmailKind values from the main app (kind is stored as a free
// string; this drives the filter dropdown).
const KINDS = [
  "PAYMENT_LINK",
  "PAYMENT_CONFIRMATION",
  "TEMPLATE_MANUAL",
  "ACCOUNT_WELCOME",
  "TRIAL_ENDING_SOON",
];

const SORTS = [
  { v: "created", label: "Newest" },
  { v: "oldest", label: "Oldest" },
  { v: "nextAttempt", label: "Next attempt" },
  { v: "attempts", label: "Most attempts" },
];

function statusTone(s: string): "good" | "warn" | "bad" | "default" {
  if (s === "SENT") return "good";
  if (s === "FAILED") return "bad";
  if (s === "PENDING") return "warn";
  return "default";
}

interface SP {
  page?: string;
  pageSize?: string;
  status?: string;
  kind?: string;
  q?: string;
  sort?: string;
}

export default async function EmailsPage({
  searchParams,
}: {
  searchParams: Promise<SP>;
}) {
  const sp = await searchParams;
  const p = parsePagination(sp);
  const filters = {
    status: sp.status || undefined,
    kind: sp.kind || undefined,
    q: sp.q || undefined,
    sort: sp.sort || undefined,
  };

  const [stats, result] = await Promise.all([
    getEmailStats(),
    listEmails(p, filters),
  ]);

  const qs = (extra: Record<string, string>) => {
    const params = new URLSearchParams();
    if (filters.status) params.set("status", filters.status);
    if (filters.kind) params.set("kind", filters.kind);
    if (filters.q) params.set("q", filters.q);
    if (filters.sort) params.set("sort", filters.sort);
    for (const [k, v] of Object.entries(extra)) params.set(k, v);
    return params.toString();
  };
  const hrefForPage = (pg: number) =>
    `/emails?${qs({ page: String(pg), pageSize: String(result.pageSize) })}`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-slate-100">
          Email Operations
        </h1>
        <a
          href={`/api/emails/export?${qs({})}`}
          className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-slate-200 hover:bg-white/5"
        >
          Export CSV
        </a>
      </div>

      {/* Status stats — the at-a-glance queue health */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Pending" value={stats.PENDING} tone="warn" />
        <StatTile label="Processing" value={stats.PROCESSING} tone="default" />
        <StatTile label="Sent" value={stats.SENT} tone="good" />
        <StatTile
          label="Failed"
          value={stats.FAILED}
          tone={stats.FAILED > 0 ? "bad" : "muted"}
        />
      </div>

      {/* Filters */}
      <form
        method="get"
        className="flex flex-wrap items-end gap-2 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3"
      >
        <label className="flex flex-col gap-1 text-[11px] text-[var(--muted)]">
          Status
          <select
            name="status"
            defaultValue={filters.status ?? ""}
            className="rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 text-sm text-slate-100"
          >
            <option value="">All</option>
            {EMAIL_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-[var(--muted)]">
          Kind
          <select
            name="kind"
            defaultValue={filters.kind ?? ""}
            className="rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 text-sm text-slate-100"
          >
            <option value="">All</option>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-[var(--muted)]">
          Sort
          <select
            name="sort"
            defaultValue={filters.sort ?? "created"}
            className="rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 text-sm text-slate-100"
          >
            {SORTS.map((s) => (
              <option key={s.v} value={s.v}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-1 flex-col gap-1 text-[11px] text-[var(--muted)]">
          Recipient
          <input
            name="q"
            defaultValue={filters.q ?? ""}
            placeholder="Search recipient email"
            className="min-w-[160px] rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-3 py-1.5 text-sm text-slate-100 outline-none focus:border-[var(--accent)]"
          />
        </label>
        <button className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-slate-200 hover:bg-white/5">
          Apply
        </button>
        <Link
          href="/emails"
          className="rounded-lg px-3 py-1.5 text-sm text-[var(--muted)] hover:text-slate-200"
        >
          Reset
        </Link>
      </form>

      <div className="overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--panel)]">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <Th>Kind</Th>
              <Th>Recipient</Th>
              <Th>Status</Th>
              <Th>Att.</Th>
              <Th>Last error</Th>
              <Th>Created</Th>
              <Th>Next attempt</Th>
              <Th>Actions</Th>
            </tr>
          </thead>
          <tbody>
            {result.items.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center">
                  <span className="text-[var(--muted)]">
                    No emails match these filters.
                  </span>
                </td>
              </tr>
            ) : (
              result.items.map((e) => (
                <tr key={e.id} className="hover:bg-white/[0.02]">
                  <Td>
                    <span className="font-mono text-[12px] text-slate-300">
                      {e.kind}
                    </span>
                  </Td>
                  <Td>
                    <Link
                      href={`/emails/${e.id}`}
                      className="text-sky-300 hover:underline"
                    >
                      {e.recipient}
                    </Link>
                  </Td>
                  <Td>
                    <Badge tone={statusTone(e.status)}>{e.status}</Badge>
                  </Td>
                  <Td>{e.attempts}</Td>
                  <Td>
                    {e.lastError ? (
                      <span
                        title={e.lastError}
                        className="block max-w-[280px] truncate text-[12px] text-red-300"
                      >
                        {e.lastError}
                      </span>
                    ) : (
                      <span className="text-[var(--muted)]">—</span>
                    )}
                  </Td>
                  <Td>
                    <span className="text-[12px] text-[var(--muted)]">
                      {fmtDateTime(e.createdAt)}
                    </span>
                  </Td>
                  <Td>
                    <span className="text-[12px] text-[var(--muted)]">
                      {fmtDateTime(e.nextAttemptAt)}
                    </span>
                  </Td>
                  <Td>
                    <EmailActions id={e.id} status={e.status} />
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Pagination
        page={result.page}
        totalPages={result.totalPages}
        total={result.total}
        hrefForPage={hrefForPage}
      />
    </div>
  );
}
