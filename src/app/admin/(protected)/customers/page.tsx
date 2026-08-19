import Link from "next/link";

import { getCustomerStats, listCustomers } from "@/console/server/services/customers";
import { parsePagination } from "@/console/server/pagination";
import { Pagination, StatTile, Td, Th, fmtDateTime, DataTable } from "@/console/components/ui";
import { ADMIN_BASE, ADMIN_API } from "@/console/lib/paths";

export const dynamic = "force-dynamic";

const SORTS = [
  { v: "activity", label: "Recent activity" },
  { v: "orders", label: "Most orders" },
  { v: "created", label: "Newest" },
  { v: "name", label: "Name" },
];

interface SP {
  page?: string;
  pageSize?: string;
  q?: string;
  org?: string;
  hasOrders?: string;
  tag?: string;
  sort?: string;
}

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<SP>;
}) {
  const sp = await searchParams;
  const p = parsePagination(sp);
  const filters = {
    q: sp.q || undefined,
    org: sp.org || undefined,
    hasOrders: sp.hasOrders || undefined,
    tag: sp.tag || undefined,
    sort: sp.sort || undefined,
  };

  const [stats, result] = await Promise.all([
    getCustomerStats(filters),
    listCustomers(p, filters),
  ]);

  const qs = (extra: Record<string, string>) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
    for (const [k, v] of Object.entries(extra)) params.set(k, v);
    return params.toString();
  };
  const hrefForPage = (pg: number) =>
    `${ADMIN_BASE}/customers?${qs({ page: String(pg), pageSize: String(result.pageSize) })}`;

  const inputCls =
    "rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-[var(--accent)]";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-slate-100">Customers</h1>
        <a
          href={`${ADMIN_API}/customers/export?${qs({})}`}
          className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-slate-200 hover:bg-white/5"
        >
          Export CSV
        </a>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <StatTile label="Total clients" value={stats.total} />
        <StatTile label="With orders" value={stats.withOrders} tone="good" />
        <StatTile label="Repeat" value={stats.repeat} tone="good" />
      </div>

      <form
        method="get"
        className="flex flex-wrap items-end gap-2 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3"
      >
        <label className="flex flex-1 flex-col gap-1 text-[11px] text-[var(--muted)]">
          Search
          <input
            name="q"
            defaultValue={filters.q ?? ""}
            placeholder="Name, email, phone or company"
            className={`${inputCls} min-w-[200px]`}
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-[var(--muted)]">
          Tag
          <input name="tag" defaultValue={filters.tag ?? ""} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-[var(--muted)]">
          Has orders
          <select name="hasOrders" defaultValue={filters.hasOrders ?? ""} className={inputCls}>
            <option value="">All</option>
            <option value="yes">With orders</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-[var(--muted)]">
          Sort
          <select name="sort" defaultValue={filters.sort ?? "activity"} className={inputCls}>
            {SORTS.map((s) => (
              <option key={s.v} value={s.v}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <button className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-slate-200 hover:bg-white/5">
          Apply
        </button>
        <Link href={`${ADMIN_BASE}/customers`} className="rounded-lg px-3 py-1.5 text-sm text-[var(--muted)] hover:text-slate-200">
          Reset
        </Link>
      </form>

      <div className="overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--panel)]">
        <DataTable caption="Customers">
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>Email</Th>
              <Th>Company</Th>
              <Th numeric>Orders</Th>
              <Th>Last order</Th>
              <Th>Tags</Th>
              <Th>{""}</Th>
            </tr>
          </thead>
          <tbody>
            {result.items.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center">
                  <span className="text-[var(--muted)]">No customers match these filters.</span>
                </td>
              </tr>
            ) : (
              result.items.map((c) => (
                <tr key={c.id} className="hover:bg-white/[0.02]">
                  <Td>
                    <Link href={`${ADMIN_BASE}/customers/${c.id}`} prefetch={false} className="text-sky-300 hover:underline">
                      {c.name}
                    </Link>
                  </Td>
                  <Td>
                    <span className="text-[12px] text-slate-300">{c.email}</span>
                  </Td>
                  <Td>
                    <span className="text-[12px] text-[var(--muted)]">{c.company ?? "—"}</span>
                  </Td>
                  <Td numeric>{c.ordersCount}</Td>
                  <Td>
                    <span className="text-[12px] text-[var(--muted)]">{fmtDateTime(c.lastOrderAt)}</span>
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {c.tags.slice(0, 3).map((t) => (
                        <span
                          key={t}
                          className="rounded bg-white/5 px-1.5 py-0.5 text-[10.5px] text-slate-400"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  </Td>
                  <Td>
                    <Link href={`${ADMIN_BASE}/customers/${c.id}`} prefetch={false} className="text-sky-300 hover:underline">
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
