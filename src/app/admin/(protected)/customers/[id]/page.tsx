import Link from "next/link";
import { notFound } from "next/navigation";

import { getCustomerById } from "@/console/server/services/customers";
import { listNotes } from "@/console/server/services/notes";
import {
  Badge,
  Card,
  Field,
  StatTile,
  fmtDate,
  fmtDateTime,
} from "@/console/components/ui";
import { NotesPanel } from "@/console/components/notes-panel";
import { formatMoney } from "@/console/lib/money";
import { ADMIN_BASE } from "@/console/lib/paths";

export const dynamic = "force-dynamic";

function statusTone(s: string): "good" | "warn" | "bad" | "default" {
  if (s === "PAID") return "good";
  if (s === "FAILED" || s === "EXPIRED") return "bad";
  if (s === "PAYMENT_PENDING" || s === "LINK_GENERATED") return "warn";
  return "default";
}

export default async function CustomerProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const c = await getCustomerById(id);
  if (!c) notFound();
  const notes = await listNotes("customer", c.id);

  return (
    <div className="space-y-4">
      <div>
        <Link href={`${ADMIN_BASE}/customers`} className="text-[12px] text-[var(--muted)] hover:text-slate-200">
          ← Customers
        </Link>
        <h1 className="mt-1 flex flex-wrap items-center gap-2 text-xl font-semibold text-slate-100">
          {c.name}
          {c.company ? (
            <span className="text-sm font-normal text-[var(--muted)]">· {c.company}</span>
          ) : null}
        </h1>
        <div className="mt-1 flex flex-wrap gap-1">
          {c.tags.map((t) => (
            <span key={t} className="rounded bg-white/5 px-1.5 py-0.5 text-[10.5px] text-slate-400">
              {t}
            </span>
          ))}
        </div>
      </div>

      {/* Lifetime aggregates — computed on-read from their orders */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <StatTile label="Orders" value={c.totalOrders} />
        <StatTile
          label="Revenue"
          value={formatMoney(c.revenue, c.currency)}
          tone="good"
          hint={
            c.multiCurrency
              ? `${c.paidOrders} paid · ${c.currency} (multi-currency)`
              : `${c.paidOrders} paid`
          }
        />
        <StatTile
          label="Avg order"
          value={formatMoney(c.aov, c.currency)}
        />
        <StatTile
          label="Refunded"
          value={formatMoney(c.refunded, c.currency)}
          tone={c.refunded > 0 ? "warn" : "muted"}
        />
        <StatTile
          label="Client since"
          value={fmtDate(c.createdAt)}
          tone="muted"
        />
      </div>

      <Card title="Identity">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Field label="Email" value={c.email} />
          <Field label="Phone" value={c.phone || "—"} />
          <Field label="Company" value={c.company ?? "—"} />
          <Field
            label="Org"
            value={c.org ? <span className="font-mono text-[12px]">{c.org}</span> : "—"}
          />
          <Field label="First order" value={fmtDateTime(c.firstOrderAt)} />
          <Field label="Last order" value={fmtDateTime(c.lastOrderAt)} />
        </div>
        {c.notes ? (
          <div className="mt-4">
            <Field
              label="Notes"
              value={<span className="whitespace-pre-wrap text-[13px]">{c.notes}</span>}
            />
          </div>
        ) : null}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={`Orders (${c.totalOrders})`}>
          {c.orders.length === 0 ? (
            <span className="text-[13px] text-[var(--muted)]">No orders yet.</span>
          ) : (
            <ul className="divide-y divide-[var(--border)]/60">
              {c.orders.map((o) => (
                <li key={o.id} className="flex items-center justify-between gap-3 py-2">
                  <Link
                    href={`${ADMIN_BASE}/orders/${o.id}`} prefetch={false}
                    className="font-mono text-[12px] text-sky-300 hover:underline"
                  >
                    {o.orderNumber}
                  </Link>
                  <div className="flex items-center gap-3">
                    <span className="tabular-nums text-[13px] text-slate-200">
                      {formatMoney(o.amount, o.currency)}
                    </span>
                    <Badge tone={statusTone(o.status)}>{o.status}</Badge>
                    <span className="text-[11px] text-[var(--muted)]">{fmtDateTime(o.createdAt)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {c.totalOrders > c.orders.length ? (
            <div className="mt-2 text-right text-[11px] text-[var(--muted)]">
              Showing latest {c.orders.length} of {c.totalOrders}
            </div>
          ) : null}
        </Card>

        <Card title={`Emails (${c.emails.length})`}>
          {c.emails.length === 0 ? (
            <span className="text-[13px] text-[var(--muted)]">No emails to this address.</span>
          ) : (
            <ul className="divide-y divide-[var(--border)]/60">
              {c.emails.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-3 py-2">
                  <Link href={`${ADMIN_BASE}/emails/${e.id}`} prefetch={false} className="text-[13px] text-sky-300 hover:underline">
                    {e.kind}
                  </Link>
                  <div className="flex items-center gap-3">
                    <Badge
                      tone={
                        e.status === "SENT"
                          ? "good"
                          : e.status === "FAILED"
                            ? "bad"
                            : "warn"
                      }
                    >
                      {e.status}
                    </Badge>
                    <span className="text-[11px] text-[var(--muted)]">{fmtDateTime(e.createdAt)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <NotesPanel subjectType="customer" subjectId={c.id} initialNotes={notes} />
    </div>
  );
}
