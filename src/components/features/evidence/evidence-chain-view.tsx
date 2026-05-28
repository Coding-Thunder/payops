import { formatCurrency, formatUtcTimestamp } from "@/lib/format";
import type { OrderEvidenceChainDTO } from "@/types";

import { CaseFileHeader } from "./case-file-header";
import { EvidenceTimeline } from "./evidence-timeline";
import { IntegrityStatement } from "./integrity-statement";
import { OutcomePanel } from "./outcome-panel";

interface EvidenceChainViewProps {
  chain: OrderEvidenceChainDTO;
  canExport: boolean;
}

/**
 * Case file — read-only dispute-defense surface.
 *
 * Composed as a single document, not a stack of cards. The dark
 * header band, the asymmetric two-column body (order evidence on the
 * left, outcome panel on the right), and the integrity statement
 * footer are intended to read as one artifact — the in-app version
 * and the exported PDF share the same skeleton.
 *
 * The previous three-card layout (Order header + Consent + Event
 * chain) is retired; consent surfaces as a row in the summary block
 * and as a fact in the outcome panel, not its own section.
 */
export function EvidenceChainView({
  chain,
  canExport,
}: EvidenceChainViewProps) {
  const { events, verification, order } = chain;
  const generatedAt = new Date().toISOString();

  return (
    <article className="bg-background text-foreground print:bg-white">
      <CaseFileHeader
        orderId={order.id}
        orderNumber={order.orderNumber}
        generatedAt={generatedAt}
        eventCount={events.length}
        integrityValid={verification.valid}
        canExport={canExport}
      />

      <div className="grid grid-cols-1 gap-x-10 gap-y-10 px-8 py-10 lg:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)] xl:gap-x-14">
        {/* ── Left column: order evidence ─────────────────────────── */}
        <section className="flex flex-col gap-8">
          <OrderSummary order={order} />

          <div>
            <SectionHeader
              label="Evidence timeline"
              suffix={`${events.length} ${events.length === 1 ? "event" : "events"}`}
            />
            <div className="mt-4">
              <EvidenceTimeline
                events={events}
                brokenAtSequence={verification.brokenAtSequence}
              />
            </div>
          </div>
        </section>

        {/* ── Right column: outcome panel ─────────────────────────── */}
        <OutcomePanel
          order={order}
          events={events}
          integrityValid={verification.valid}
        />
      </div>

      <IntegrityStatement
        generatedAt={generatedAt}
        eventCount={events.length}
        headHash={verification.headHash}
        valid={verification.valid}
      />
    </article>
  );
}

/* ─────────────────────── primitives ─────────────────────────────────── */

function OrderSummary({
  order,
}: {
  order: OrderEvidenceChainDTO["order"];
}) {
  const items = order.lineItems
    .map((l) => (l.quantity > 1 ? `${l.quantity}× ${l.name}` : l.name))
    .filter(Boolean);
  const itemsText = items.length > 0 ? items.join(", ") : "—";

  const rows: Array<{ k: string; v: React.ReactNode; mono?: boolean }> = [
    { k: "Customer", v: order.customer.name },
    { k: "Customer email", v: order.customer.email, mono: true },
    {
      k: "Amount",
      v: formatCurrency(order.pricing.amount, order.pricing.currency),
      mono: true,
    },
    { k: "Status", v: order.status, mono: true },
    {
      k: "Order created",
      v: formatUtcTimestamp(order.createdAt),
      mono: true,
    },
    {
      k: "Paid",
      v: order.payment.paidAt
        ? formatUtcTimestamp(order.payment.paidAt)
        : "—",
      mono: true,
    },
    { k: "Gateway", v: order.payment.gateway ?? "—", mono: true },
    {
      k: "Items",
      v: itemsText,
    },
  ];

  if (order.scheduling) {
    rows.push({
      k: "Window",
      v: `${formatUtcTimestamp(order.scheduling.startsAt)}${
        order.scheduling.endsAt
          ? ` → ${formatUtcTimestamp(order.scheduling.endsAt)}`
          : ""
      }`,
      mono: true,
    });
  }

  return (
    <div>
      <SectionHeader label="Order summary" />
      <dl className="mt-4 divide-y divide-border/60">
        {rows.map((r) => (
          <div
            key={r.k}
            className="grid grid-cols-[10rem_1fr] items-baseline gap-x-4 py-2"
          >
            <dt className="text-[12.5px] text-muted-foreground">{r.k}</dt>
            <dd
              className={
                r.mono
                  ? "font-mono text-[12.5px] tabular-nums break-all"
                  : "text-[13px]"
              }
            >
              {r.v}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function SectionHeader({
  label,
  suffix,
}: {
  label: string;
  suffix?: string;
}) {
  return (
    <div className="flex items-baseline justify-between border-b border-border/70 pb-2">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </h2>
      {suffix ? (
        <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
          {suffix}
        </span>
      ) : null}
    </div>
  );
}
