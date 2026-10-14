import Link from "next/link";

import {
  ENQUIRY_STATUSES,
  listEnquiries,
} from "@/console/server/services/quotations";
import { parsePagination } from "@/console/server/pagination";
import {
  Badge,
  DataTable,
  Pagination,
  Td,
  Th,
  fmtDate,
} from "@/console/components/ui";
import { ADMIN_BASE } from "@/console/lib/paths";
import { requireAdminPage } from "@/console/server/auth/session";

export const dynamic = "force-dynamic";

function notifyTone(s: string): "good" | "warn" | "bad" | "default" {
  if (s === "SENT") return "good";
  if (s === "FAILED") return "bad";
  if (s === "SKIPPED") return "warn";
  return "default";
}

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function QuotationsPage({
  searchParams,
}: {
  searchParams: Promise<{
    page?: string;
    pageSize?: string;
    q?: string;
    status?: string;
  }>;
}) {
  // Defence in depth. `src/proxy.ts` already refuses this request without a
  // valid admin session, so nothing should reach here unauthenticated — but a
  // layout `redirect()` does NOT stop a page rendering (the App Router runs
  // them concurrently and attaches the rendered payload to the 307), so the
  // guard has to be awaited HERE, before any data is read, for this page to be
  // safe on its own. Awaiting it first is the whole point: it must precede
  // every query below.
  await requireAdminPage();
  const sp = await searchParams;
  const p = parsePagination(sp);
  const q = one(sp.q)?.slice(0, 80) ?? "";
  const status = one(sp.status) ?? "";
  const result = await listEnquiries(p, { q, status });

  const hrefForPage = (pg: number) => {
    const params = new URLSearchParams();
    params.set("page", String(pg));
    params.set("pageSize", String(result.pageSize));
    if (q) params.set("q", q);
    if (status) params.set("status", status);
    return `${ADMIN_BASE}/quotations?${params.toString()}`;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-100">Enquiries</h1>
        <span className="text-[12px] text-[var(--muted)]">
          {result.total} total
        </span>
      </div>

      {/* GET form, so filters are shareable and the page stays server-rendered. */}
      <form
        method="GET"
        action={`${ADMIN_BASE}/quotations`}
        className="flex flex-wrap items-end gap-2"
      >
        <div className="flex flex-col gap-1">
          <label
            htmlFor="eq-q"
            className="text-[11px] uppercase tracking-[0.12em] text-[var(--muted)]"
          >
            Search
          </label>
          <input
            id="eq-q"
            name="q"
            defaultValue={q}
            maxLength={80}
            placeholder="Name, email or company"
            className="h-9 w-64 rounded-md border border-[var(--border)] bg-[var(--panel)] px-3 text-[13px] text-slate-100 outline-none focus:border-slate-500"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label
            htmlFor="eq-status"
            className="text-[11px] uppercase tracking-[0.12em] text-[var(--muted)]"
          >
            Status
          </label>
          <select
            id="eq-status"
            name="status"
            defaultValue={status}
            className="h-9 rounded-md border border-[var(--border)] bg-[var(--panel)] px-2 text-[13px] text-slate-100 outline-none focus:border-slate-500"
          >
            <option value="">Any</option>
            {ENQUIRY_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          className="h-9 rounded-md border border-[var(--border)] bg-[var(--panel)] px-3 text-[13px] text-slate-100 hover:border-slate-500"
        >
          Apply
        </button>
        {q || status ? (
          <Link
            href={`${ADMIN_BASE}/quotations`}
            className="h-9 px-2 text-[12px] leading-9 text-[var(--muted)] hover:text-slate-200"
          >
            Clear
          </Link>
        ) : null}
      </form>

      <div className="overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--panel)]">
        <DataTable caption="General enquiries">
          <thead>
            <tr>
              <Th>Received</Th>
              <Th>Name</Th>
              <Th>Business email</Th>
              <Th>Company</Th>
              <Th>Source</Th>
              <Th>Status</Th>
              <Th>Notification</Th>
              <Th>Detail</Th>
            </tr>
          </thead>
          <tbody>
            {result.items.length === 0 ? (
              <tr>
                {/* Raw <td colSpan>, not <Td>: the console's Td takes only
                    {children, numeric} and renders a bare cell, so an empty
                    state built from it occupies column 1 alone. In an
                    8-column auto-layout table that left the message in a
                    330px box at the far left and stretched the "Received"
                    header to match it, so the empty table's columns did not
                    line up with the populated one's. Every sibling page here
                    (orders, emails, audit, customers) already spans the row
                    this way. */}
                <td colSpan={8} className="px-3 py-8 text-center">
                  <span className="text-[var(--muted)]">
                    {q || status
                      ? "No enquiries match that filter."
                      : "No enquiries yet."}
                  </span>
                </td>
              </tr>
            ) : (
              result.items.map((e) => (
                <tr key={e.id}>
                  <Td>{fmtDate(e.createdAt)}</Td>
                  <Td>{e.name || "—"}</Td>
                  <Td>{e.email || "—"}</Td>
                  <Td>{e.company ?? "—"}</Td>
                  <Td>
                    <Badge tone="default">{e.source}</Badge>
                  </Td>
                  <Td>
                    <Badge tone={e.status === "PENDING" ? "warn" : "default"}>
                      {e.status}
                    </Badge>
                  </Td>
                  <Td>
                    <Badge tone={notifyTone(e.notificationStatus)}>
                      {e.notificationStatus}
                    </Badge>
                  </Td>
                  <Td>
                    <Link
                      href={`${ADMIN_BASE}/quotations/${e.id}`}
                      className="text-[12px] text-slate-300 underline-offset-4 hover:text-slate-100 hover:underline"
                    >
                      Open
                    </Link>
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </DataTable>
      </div>

      <Pagination
        page={result.page}
        totalPages={result.totalPages}
        total={result.total}
        hrefForPage={hrefForPage}
      />

      <p className="text-[12px] leading-relaxed text-[var(--muted)]">
        Read-only. Waitlist entries are a separate surface and are never listed
        here, so the beta waitlist count is unaffected by anything on this page.
        A <strong>SKIPPED</strong> or <strong>FAILED</strong> notification means
        the lead was stored but the internal email did not go out — the enquiry
        is still here and still answerable.
      </p>
    </div>
  );
}
