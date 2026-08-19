import Link from "next/link";
import { notFound } from "next/navigation";

import { getOrderById } from "@/console/server/services/orders";
import { listNotes } from "@/console/server/services/notes";
import { Badge, Card, Field, Td, Th, fmtDateTime } from "@/console/components/ui";
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

export default async function OrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const o = await getOrderById(id);
  if (!o) notFound();
  const notes = await listNotes("order", o.id);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href={`${ADMIN_BASE}/orders`} className="text-[12px] text-[var(--muted)] hover:text-slate-200">
            ← Orders &amp; Payments
          </Link>
          <h1 className="mt-1 flex items-center gap-2 text-xl font-semibold text-slate-100">
            <span className="font-mono">{o.orderNumber}</span>
            <Badge tone={statusTone(o.status)}>{o.status}</Badge>
            {o.paid ? <Badge tone="good">PAID</Badge> : null}
            {o.refundedAmount > 0 ? <Badge tone="warn">REFUNDED</Badge> : null}
          </h1>
          <div className="mt-0.5 font-mono text-[12px] text-[var(--muted)]">{o.id}</div>
        </div>
        <div className="text-right">
          <div className="text-2xl font-semibold tabular-nums text-slate-100">
            {formatMoney(o.amount, o.currency)}
          </div>
          {o.refundedAmount > 0 ? (
            <div className="text-[12px] text-amber-300">
              −{formatMoney(o.refundedAmount, o.currency)} refunded
            </div>
          ) : null}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Customer">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Name" value={o.customerName} />
            <Field label="Email" value={o.customerEmail} />
            <Field label="Phone" value={o.customerPhone ?? "—"} />
            <Field
              label="Client id"
              value={
                o.customerId ? (
                  <span className="font-mono text-[12px]">{o.customerId}</span>
                ) : (
                  "—"
                )
              }
            />
            <Field
              label="Org"
              value={o.org ? <span className="font-mono text-[12px]">{o.org}</span> : "—"}
            />
            <Field label="Created by" value={o.createdByEmail ?? "—"} />
          </div>
        </Card>

        <Card title="Payment">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Gateway" value={o.payment.gateway ?? "—"} />
            <Field label="Payment status" value={o.payment.status ?? "—"} />
            <Field label="Paid at" value={fmtDateTime(o.paidAt)} />
            <Field
              label="Amount received"
              value={formatMoney(o.payment.amountReceived, o.currency)}
            />
            <Field
              label="Consent"
              value={o.consentStatus ?? "—"}
            />
            <Field label="Dispute" value={o.disputeStatus ?? "—"} />
            <Field
              label="Session id"
              value={
                o.payment.sessionId ? (
                  <span className="break-all font-mono text-[11px]">{o.payment.sessionId}</span>
                ) : (
                  "—"
                )
              }
            />
            <Field
              label="Intent id"
              value={
                o.payment.intentId ? (
                  <span className="break-all font-mono text-[11px]">{o.payment.intentId}</span>
                ) : (
                  "—"
                )
              }
            />
          </div>
          {o.payment.failureReason ? (
            <div className="mt-3">
              <Field
                label="Failure reason"
                value={<span className="text-[12px] text-red-300">{o.payment.failureReason}</span>}
              />
            </div>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-3 text-[12px]">
            {o.payment.checkoutUrl ? (
              <a href={o.payment.checkoutUrl} target="_blank" rel="noreferrer" className="text-sky-300 hover:underline">
                Checkout link ↗
              </a>
            ) : null}
            {o.payment.receiptUrl ? (
              <a href={o.payment.receiptUrl} target="_blank" rel="noreferrer" className="text-sky-300 hover:underline">
                Receipt ↗
              </a>
            ) : null}
          </div>
        </Card>
      </div>

      {o.lineItems.length > 0 ? (
        <Card title="Line items">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th>Item</Th>
                  <Th>Qty</Th>
                  <Th>Unit</Th>
                  <Th>Total</Th>
                </tr>
              </thead>
              <tbody>
                {o.lineItems.map((li, i) => (
                  <tr key={i}>
                    <Td>{li.name}</Td>
                    <Td>{li.quantity}</Td>
                    <Td>{formatMoney(li.unitPrice, o.currency)}</Td>
                    <Td>{formatMoney(li.total, o.currency)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={`Emails (${o.emails.length})`}>
          {o.emails.length === 0 ? (
            <span className="text-[13px] text-[var(--muted)]">No emails for this order.</span>
          ) : (
            <ul className="divide-y divide-[var(--border)]/60">
              {o.emails.map((e) => (
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

        <Card title={`Audit (${o.audit.length})`}>
          <div className="mb-2 text-right">
            <Link
              href={`${ADMIN_BASE}/audit?source=product&id=${o.id}`}
              className="text-[12px] text-sky-300 hover:underline"
            >
              View all in Audit Center →
            </Link>
          </div>
          {o.audit.length === 0 ? (
            <span className="text-[13px] text-[var(--muted)]">No audit events for this order.</span>
          ) : (
            <ul className="divide-y divide-[var(--border)]/60">
              {o.audit.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-3 py-2">
                  <Link
                    href={`${ADMIN_BASE}/audit/${a.id}?source=product`} prefetch={false}
                    className="font-mono text-[12px] text-sky-300 hover:underline"
                  >
                    {a.action}
                  </Link>
                  <div className="flex items-center gap-3">
                    <span className="text-[11px] text-[var(--muted)]">{a.actor}</span>
                    <span className="text-[11px] text-[var(--muted)]">{fmtDateTime(a.createdAt)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <NotesPanel subjectType="order" subjectId={o.id} initialNotes={notes} />
    </div>
  );
}
