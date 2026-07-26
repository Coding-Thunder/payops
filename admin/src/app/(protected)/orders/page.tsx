import Link from "next/link";

import {
  getOrderStats,
  listOrders,
  ORDER_STATUSES,
  GATEWAYS,
} from "@/server/services/orders";
import { parsePagination } from "@/server/pagination";
import { Badge, Pagination, StatTile, Td, Th, fmtDateTime } from "@/components/ui";
import { formatMoney } from "@/lib/money";

export const dynamic = "force-dynamic";

const SORTS = [
  { v: "created", label: "Newest" },
  { v: "oldest", label: "Oldest" },
  { v: "paid", label: "Recently paid" },
  { v: "amount", label: "Amount" },
];

function statusTone(s: string): "good" | "warn" | "bad" | "default" {
  if (s === "PAID") return "good";
  if (s === "FAILED" || s === "EXPIRED") return "bad";
  if (s === "PAYMENT_PENDING" || s === "LINK_GENERATED") return "warn";
  return "default";
}

interface SP {
  page?: string;
  pageSize?: string;
  status?: string;
  gateway?: string;
  paid?: string;
  q?: string;
  org?: string;
  from?: string;
  to?: string;
  sort?: string;
}

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<SP>;
}) {
  const sp = await searchParams;
  const p = parsePagination(sp);
  const filters = {
    status: sp.status || undefined,
    gateway: sp.gateway || undefined,
    paid: sp.paid || undefined,
    q: sp.q || undefined,
    org: sp.org || undefined,
    from: sp.from || undefined,
    to: sp.to || undefined,
    sort: sp.sort || undefined,
  };

  const [stats, result] = await Promise.all([
    getOrderStats(filters),
    listOrders(p, filters),
  ]);

  const qs = (extra: Record<string, string>) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
    for (const [k, v] of Object.entries(extra)) params.set(k, v);
    return params.toString();
  };
  const hrefForPage = (pg: number) =>
    `/orders?${qs({ page: String(pg), pageSize: String(result.pageSize) })}`;

  const inputCls =
    "rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-[var(--accent)]";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-slate-100">
          Orders &amp; Payments
        </h1>
        <a
          href={`/api/orders/export?${qs({})}`}
          className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-slate-200 hover:bg-white/5"
        >
          Export CSV
        </a>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <StatTile label="Total" value={stats.total} />
        <StatTile label="Paid" value={stats.paid} tone="good" />
        <StatTile label="Pending" value={stats.pending} tone="warn" />
        <StatTile
          label="Failed"
          value={stats.failed}
          tone={stats.failed > 0 ? "bad" : "muted"}
        />
        <StatTile
          label="Refunded"
          value={stats.refunded}
          tone={stats.refunded > 0 ? "warn" : "muted"}
        />
      </div>

      <form
        method="get"
        className="flex flex-wrap items-end gap-2 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3"
      >
        <label className="flex flex-col gap-1 text-[11px] text-[var(--muted)]">
          Status
          <select name="status" defaultValue={filters.status ?? ""} className={inputCls}>
            <option value="">All</option>
            {ORDER_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-[var(--muted)]">
          Gateway
          <select name="gateway" defaultValue={filters.gateway ?? ""} className={inputCls}>
            <option value="">All</option>
            {GATEWAYS.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-[var(--muted)]">
          Paid
          <select name="paid" defaultValue={filters.paid ?? ""} className={inputCls}>
            <option value="">All</option>
            <option value="paid">Paid</option>
            <option value="unpaid">Unpaid</option>
          </select>
        </label>
        <label className="flex flex-1 flex-col gap-1 text-[11px] text-[var(--muted)]">
          Search
          <input
            name="q"
            defaultValue={filters.q ?? ""}
            placeholder="Order #, customer name or email"
            className={`${inputCls} min-w-[180px]`}
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-[var(--muted)]">
          From
          <input type="date" name="from" defaultValue={filters.from ?? ""} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-[var(--muted)]">
          To
          <input type="date" name="to" defaultValue={filters.to ?? ""} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-[var(--muted)]">
          Sort
          <select name="sort" defaultValue={filters.sort ?? "created"} className={inputCls}>
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
        <Link href="/orders" className="rounded-lg px-3 py-1.5 text-sm text-[var(--muted)] hover:text-slate-200">
          Reset
        </Link>
      </form>

      <div className="overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--panel)]">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <Th>Order</Th>
              <Th>Customer</Th>
              <Th>Amount</Th>
              <Th>Status</Th>
              <Th>Gateway</Th>
              <Th>Refunded</Th>
              <Th>Created</Th>
              <Th>{""}</Th>
            </tr>
          </thead>
          <tbody>
            {result.items.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center">
                  <span className="text-[var(--muted)]">No orders match these filters.</span>
                </td>
              </tr>
            ) : (
              result.items.map((o) => (
                <tr key={o.id} className="hover:bg-white/[0.02]">
                  <Td>
                    <Link href={`/orders/${o.id}`} className="font-mono text-[12px] text-sky-300 hover:underline">
                      {o.orderNumber}
                    </Link>
                  </Td>
                  <Td>
                    <div className="leading-tight">
                      <div className="text-[13px] text-slate-200">{o.customerName}</div>
                      <div className="text-[11px] text-[var(--muted)]">{o.customerEmail}</div>
                    </div>
                  </Td>
                  <Td>
                    <span className="tabular-nums text-slate-100">
                      {formatMoney(o.amount, o.currency)}
                    </span>
                  </Td>
                  <Td>
                    <Badge tone={statusTone(o.status)}>{o.status}</Badge>
                  </Td>
                  <Td>
                    <span className="text-[12px] text-[var(--muted)]">{o.gateway ?? "—"}</span>
                  </Td>
                  <Td>
                    {o.refundedAmount > 0 ? (
                      <span className="tabular-nums text-amber-300">
                        {formatMoney(o.refundedAmount, o.currency)}
                      </span>
                    ) : (
                      <span className="text-[var(--muted)]">—</span>
                    )}
                  </Td>
                  <Td>
                    <span className="text-[12px] text-[var(--muted)]">{fmtDateTime(o.createdAt)}</span>
                  </Td>
                  <Td>
                    <Link href={`/orders/${o.id}`} className="text-sky-300 hover:underline">
                      View
                    </Link>
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
