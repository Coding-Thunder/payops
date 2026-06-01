/**
 * Integrity region, three semantically-toned stats + an anchor
 * pillar + six footnoted pillars + commerce-shapes inline ledger.
 *
 * The three stats each carry a distinct identity color (green /
 * blue / amber) so the strip reads as multi-tonal operational
 * truth, not green-monochrome. Each stat has a thin top accent in
 * its semantic color, same compositional move as the dashboard
 * reference's KPI tiles.
 */

interface Stat {
  label: string;
  value: string;
  note: string;
  tone: "success" | "info" | "warning";
}

const STATS: Stat[] = [
  {
    label: "Webhook idempotency",
    value: "100%",
    note: "Every gateway event collapses to one transition.",
    tone: "success",
  },
  {
    label: "Drift between surfaces",
    value: "0",
    note: "One record · realtime push + polling backstop.",
    tone: "info",
  },
  {
    label: "Evidence retention",
    value: "∞",
    note: "Paid, refunded, disputed, kept forever.",
    tone: "warning",
  },
];

const SHAPES: Array<{
  vertical: string;
  itemTypeKey: string;
  attrs: string;
  evidence: string;
}> = [
  {
    vertical: "Retail",
    itemTypeKey: "product",
    attrs: "sku · size · color · image",
    evidence: "gateway receipt + delivery proof",
  },
  {
    vertical: "Grocery",
    itemTypeKey: "grocery_sku",
    attrs: "unit · weight · batch_lot",
    evidence: "pick-list + signed delivery",
  },
  {
    vertical: "Pharmacy",
    itemTypeKey: "rx_product",
    attrs: "rx_number · dose · insurance_id",
    evidence: "rx signature + insurance verify",
  },
  {
    vertical: "Repair",
    itemTypeKey: "repair_job",
    attrs: "device_id · diagnosis · parts_used",
    evidence: "pre/post photos + sign-off",
  },
  {
    vertical: "Dealership",
    itemTypeKey: "vehicle_sale",
    attrs: "vin · model_year · financing_terms",
    evidence: "signed contract + title transfer",
  },
  {
    vertical: "Services",
    itemTypeKey: "service_visit",
    attrs: "service_code · technician · duration",
    evidence: "completion + customer signature",
  },
  {
    vertical: "Equipment",
    itemTypeKey: "rental_booking",
    attrs: "asset_id · starts_at · ends_at",
    evidence: "condition photos + handover log",
  },
  {
    vertical: "B2B",
    itemTypeKey: "net_invoice",
    attrs: "po_number · terms_days · contract_ref",
    evidence: "PO match + remittance trail",
  },
];

const PILLARS: Array<{ k: string; title: string; body: string }> = [
  {
    k: "01",
    title: "Backend authority, never UI optimism",
    body: "Every status badge derives from the canonical record. The dashboard, the order detail, and the dispute log read the same row at the same time.",
  },
  {
    k: "02",
    title: "Append-only audit log",
    body: "Typed audit rows with actor, IP, user-agent, and metadata. Not editable, even by admins.",
  },
  {
    k: "03",
    title: "Hashed evidence chain",
    body: "Per-order events chain-hash to the previous entry. Any rewrite breaks the chain, provable to disputes and regulators.",
  },
  {
    k: "04",
    title: "Atomic webhook handling",
    body: "Idempotent, defensively ordered, conditional updates. Duplicate Stripe delivery is a no-op. Retried reconcile is a no-op.",
  },
  {
    k: "05",
    title: "Operations-grade idempotency",
    body: "Consent recorded once. Confirmation emails sent once. Refunds ratchet forward, never backward.",
  },
  {
    k: "06",
    title: "Retention by design",
    body: "Paid orders never delete. Refunded orders never delete. Risk-flagged orders persist through archive, surfaces dim, records stay.",
  },
];

const TONE_MAP: Record<Stat["tone"], { label: string; bar: string; value: string }> = {
  success: {
    label: "var(--success-strong)",
    bar: "var(--success)",
    value: "var(--foreground)",
  },
  info: {
    label: "var(--info)",
    bar: "var(--info)",
    value: "var(--foreground)",
  },
  warning: {
    label: "oklch(0.52 0.15 78)",
    bar: "var(--warning)",
    value: "var(--foreground)",
  },
};

export function IntegrityRegion() {
  return (
    <section id="integrity" className="scroll-mt-20 pt-20 sm:pt-28">
      {/* Stats, three columns, each with a top accent bar in its
          semantic tone. No card chrome; the accent + typography
          carries the identity. */}
      <dl className="grid grid-cols-1 gap-y-8 sm:grid-cols-3 sm:gap-x-10">
        {STATS.map((s) => {
          const tone = TONE_MAP[s.tone];
          return (
            <div key={s.label} className="relative pt-4">
              <span
                aria-hidden
                className="absolute inset-x-0 top-0 h-[2px] rounded-full"
                style={{ background: tone.bar }}
              />
              <dt
                className="font-mono text-[10.5px] uppercase tracking-[0.14em]"
                style={{ color: tone.label }}
              >
                {s.label}
              </dt>
              <dd
                className="mt-2 font-mono text-[40px] font-semibold leading-none tracking-tight tabular-nums"
                style={{ color: tone.value }}
              >
                {s.value}
              </dd>
              <p className="mt-2 max-w-[36ch] text-[12.5px] leading-relaxed text-muted-foreground">
                {s.note}
              </p>
            </div>
          );
        })}
      </dl>

      {/* Anchor pillar */}
      <div className="mt-16 grid grid-cols-[2.5rem_1fr] items-baseline gap-x-3">
        <span
          className="font-mono text-[12px] tabular-nums"
          style={{ color: "var(--success-strong)" }}
        >
          00
        </span>
        <div>
          <h2 className="max-w-[28ch] text-balance text-[26px] sm:text-[30px] font-semibold leading-[1.15] tracking-[-0.018em]">
            Compliance isn&apos;t an export feature. It&apos;s the schema.
          </h2>
          <p className="mt-4 max-w-[60ch] text-[14.5px] leading-relaxed text-muted-foreground">
            Every record TraceTxn writes is shaped for the conversation
            finance has with auditors and banks. Actor identity, request
            context, hash linkage, and immutability proofs are storage
            primitives, not a reporting layer added on later.
          </p>
        </div>
      </div>

      {/* Pillars */}
      <div className="mt-12 grid grid-cols-1 gap-x-12 gap-y-8 border-t border-border pt-10 md:grid-cols-2">
        {PILLARS.map((p) => (
          <div
            key={p.k}
            className="grid grid-cols-[2.5rem_1fr] items-baseline gap-x-3"
          >
            <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
              {p.k}
            </span>
            <div>
              <h3 className="text-[14px] font-semibold tracking-tight">
                {p.title}
              </h3>
              <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted-foreground">
                {p.body}
              </p>
            </div>
          </div>
        ))}
      </div>

      {/* Commerce shapes inline ledger */}
      <div className="mt-16">
        <div className="flex items-baseline justify-between border-b border-border pb-2">
          <h3 className="text-[13px] font-semibold tracking-tight">
            The schema bends to your business
          </h3>
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
            itemType · attributes · evidence
          </span>
        </div>
        <ul className="divide-y divide-border">
          {SHAPES.map((s) => (
            <li
              key={s.itemTypeKey}
              className="grid grid-cols-1 items-baseline gap-x-6 gap-y-1 py-2.5 md:grid-cols-[7rem_minmax(0,10rem)_minmax(0,1fr)_minmax(0,1.1fr)]"
            >
              <span className="text-[13px] font-medium">{s.vertical}</span>
              <span
                className="font-mono text-[11.5px]"
                style={{ color: "var(--success-strong)" }}
              >
                {s.itemTypeKey}
              </span>
              <span className="font-mono text-[11.5px] text-muted-foreground">
                {s.attrs}
              </span>
              <span className="font-mono text-[11.5px] text-muted-foreground">
                {s.evidence}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-5 max-w-[64ch] text-[13px] leading-relaxed text-muted-foreground">
          Catalog editor accepts any shape. If your business doesn&apos;t
          appear above, the same backbone carries it, define your item
          type, declare your attributes, run your first order.
        </p>
      </div>
    </section>
  );
}
