import Link from "next/link";

import {
  listAudit,
  normalizeSource,
  type AuditSource,
} from "@/console/server/services/audit-center";
import { parsePagination } from "@/console/server/pagination";
import { Pagination, Td, Th, fmtDateTime, DataTable } from "@/console/components/ui";
import { ADMIN_BASE, ADMIN_API } from "@/console/lib/paths";

export const dynamic = "force-dynamic";

interface SP {
  source?: string;
  page?: string;
  pageSize?: string;
  action?: string;
  actor?: string;
  type?: string;
  id?: string;
  from?: string;
  to?: string;
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<SP>;
}) {
  const sp = await searchParams;
  const source = normalizeSource(sp.source);
  const p = parsePagination(sp);
  const filters = {
    action: sp.action || undefined,
    actor: sp.actor || undefined,
    type: sp.type || undefined,
    id: sp.id || undefined,
    from: sp.from || undefined,
    to: sp.to || undefined,
  };
  const result = await listAudit(source, p, filters);

  const qs = (extra: Record<string, string>) => {
    const params = new URLSearchParams();
    params.set("source", source);
    for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
    for (const [k, v] of Object.entries(extra)) params.set(k, v);
    return params.toString();
  };
  const hrefForPage = (pg: number) =>
    `${ADMIN_BASE}/audit?${qs({ page: String(pg), pageSize: String(result.pageSize) })}`;

  const srcHref = (s: AuditSource) => {
    const params = new URLSearchParams();
    params.set("source", s);
    for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
    return `${ADMIN_BASE}/audit?${params.toString()}`;
  };
  const tab = (s: AuditSource, label: string) => (
    <Link
      href={srcHref(s)}
      className={`rounded-md px-3 py-1.5 text-sm ${
        source === s
          ? "bg-white/10 text-slate-100"
          : "text-[var(--muted)] hover:text-slate-200"
      }`}
    >
      {label}
    </Link>
  );

  const inputCls =
    "rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-[var(--accent)]";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-slate-100">Audit Center</h1>
        <a
          href={`${ADMIN_API}/audit/export?${qs({})}`}
          className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-slate-200 hover:bg-white/5"
        >
          Export CSV
        </a>
      </div>

      <div className="flex gap-1 rounded-lg border border-[var(--border)] bg-[var(--panel)] p-1">
        {tab("product", "Product events")}
        {tab("console", "Console actions")}
      </div>

      <form
        method="get"
        className="flex flex-wrap items-end gap-2 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3"
      >
        <input type="hidden" name="source" value={source} />
        <label className="flex flex-col gap-1 text-[11px] text-[var(--muted)]">
          Action
          <input
            name="action"
            defaultValue={filters.action ?? ""}
            placeholder="e.g. PAYMENT"
            className={inputCls}
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-[var(--muted)]">
          Actor
          <input
            name="actor"
            defaultValue={filters.actor ?? ""}
            placeholder="email"
            className={inputCls}
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-[var(--muted)]">
          {source === "console" ? "Target type" : "Entity type"}
          <input
            name="type"
            defaultValue={filters.type ?? ""}
            placeholder={source === "console" ? "user" : "ORDER"}
            className={inputCls}
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-[var(--muted)]">
          {source === "console" ? "Target id" : "Entity id"}
          <input name="id" defaultValue={filters.id ?? ""} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-[var(--muted)]">
          From
          <input
            type="date"
            name="from"
            defaultValue={filters.from ?? ""}
            className={inputCls}
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-[var(--muted)]">
          To
          <input
            type="date"
            name="to"
            defaultValue={filters.to ?? ""}
            className={inputCls}
          />
        </label>
        <button className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-slate-200 hover:bg-white/5">
          Apply
        </button>
        <Link
          href={`${ADMIN_BASE}/audit?source=${source}`}
          className="rounded-lg px-3 py-1.5 text-sm text-[var(--muted)] hover:text-slate-200"
        >
          Reset
        </Link>
      </form>

      <div className="overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--panel)]">
        <DataTable caption="Audit events">
          <thead>
            <tr>
              <Th>Action</Th>
              <Th>Actor</Th>
              <Th>Entity</Th>
              {source === "product" ? <Th>Org</Th> : null}
              <Th>IP</Th>
              <Th>When</Th>
              <Th>{""}</Th>
            </tr>
          </thead>
          <tbody>
            {result.items.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center">
                  <span className="text-[var(--muted)]">
                    No audit events match these filters.
                  </span>
                </td>
              </tr>
            ) : (
              result.items.map((a) => (
                <tr key={a.id} className="hover:bg-white/[0.02]">
                  <Td>
                    <span className="font-mono text-[12px] text-slate-200">
                      {a.action}
                    </span>
                  </Td>
                  <Td>
                    <span className="text-[12px]">{a.actor}</span>
                  </Td>
                  <Td>
                    <span className="font-mono text-[12px] text-[var(--muted)]">
                      {a.entity}
                    </span>
                  </Td>
                  {source === "product" ? (
                    <Td>
                      <span className="font-mono text-[11px] text-[var(--muted)]">
                        {a.org ?? "—"}
                      </span>
                    </Td>
                  ) : null}
                  <Td>
                    <span className="font-mono text-[11px] text-[var(--muted)]">
                      {a.ip ?? "—"}
                    </span>
                  </Td>
                  <Td>
                    <span className="text-[12px] text-[var(--muted)]">
                      {fmtDateTime(a.createdAt)}
                    </span>
                  </Td>
                  <Td>
                    <Link
                      href={`${ADMIN_BASE}/audit/${a.id}?source=${a.source}`} prefetch={false}
                      className="text-sky-300 hover:underline"
                    >
                      View
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
    </div>
  );
}
