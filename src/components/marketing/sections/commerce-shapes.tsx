import { MarketingSection, AccentWord } from "../section";

/**
 * Commerce Shapes — "is this for my business?" chapter.
 *
 * Two lead verticals get an editorial block (vertical name + one
 * narrative sentence + the three-row spec). The remaining six form a
 * compact tabular reading list below — borderless, mono, dense.
 *
 * Asymmetric on purpose: "lead with two examples, list the rest."
 * Reads as a developer-grade spec sheet, not a feature card grid.
 */

interface CommerceShape {
  vertical: string;
  itemTypeKey: string;
  attrs: string[];
  evidence: string;
  /** Present for the two lead examples only. */
  blurb?: string;
}

const LEAD: CommerceShape[] = [
  {
    vertical: "Retail",
    itemTypeKey: "product",
    attrs: ["sku", "size", "color", "image"],
    evidence: "gateway receipt + delivery proof",
    blurb:
      "General-purpose product SKUs with sized and styled variants. Receipt + delivery proof carry the dispute story.",
  },
  {
    vertical: "B2B",
    itemTypeKey: "net_invoice",
    attrs: ["po_number", "terms_days", "contract_ref"],
    evidence: "PO match + remittance trail",
    blurb:
      "Net-terms invoicing, contract-referenced. PO match + remittance trail close the loop on every invoice.",
  },
];

const LIST: CommerceShape[] = [
  {
    vertical: "Grocery",
    itemTypeKey: "grocery_sku",
    attrs: ["unit", "weight", "batch_lot"],
    evidence: "pick-list + signed delivery",
  },
  {
    vertical: "Pharmacy",
    itemTypeKey: "rx_product",
    attrs: ["rx_number", "dose", "insurance_id"],
    evidence: "rx signature + insurance verify",
  },
  {
    vertical: "Repair",
    itemTypeKey: "repair_job",
    attrs: ["device_id", "diagnosis", "parts_used"],
    evidence: "pre/post photos + sign-off",
  },
  {
    vertical: "Dealership",
    itemTypeKey: "vehicle_sale",
    attrs: ["vin", "model_year", "financing_terms"],
    evidence: "signed contract + title transfer",
  },
  {
    vertical: "Services",
    itemTypeKey: "service_visit",
    attrs: ["service_code", "technician", "duration"],
    evidence: "completion + customer signature",
  },
  {
    vertical: "Equipment",
    itemTypeKey: "rental_booking",
    attrs: ["asset_id", "starts_at", "ends_at"],
    evidence: "condition photos + handover log",
  },
];

export function CommerceShapes() {
  return (
    <MarketingSection
      id="shapes"
      theme="graphite"
      eyebrow="One backbone · many shapes of commerce"
      title={
        <>
          Same lifecycle. The schema{" "}
          <AccentWord>bends to your business.</AccentWord>
        </>
      }
      description={
        <>
          TraceTxn stores commerce as three primitives —{" "}
          <span className="font-mono text-current">item types</span>{" "}
          (what you sell),{" "}
          <span className="font-mono text-current">orders</span>{" "}
          (what was bought), and{" "}
          <span className="font-mono text-current">evidence</span>{" "}
          (what happened). The schema for each is yours. No vertical
          assumptions in the core; the same primitives carry custom
          commerce shapes that don&apos;t have an industry label yet.
        </>
      }
    >
      {/* ── Lead block: two editorial examples ───────────────────── */}
      <div
        data-reveal
        data-reveal-order={0}
        className="rounded-2xl border"
        style={{ borderColor: "var(--m-border)" }}
      >
        {LEAD.map((s, i) => (
          <LeadRow
            key={s.itemTypeKey}
            shape={s}
            withDivider={i !== LEAD.length - 1}
          />
        ))}
      </div>

      {/* ── Compact list: six more verticals ─────────────────────── */}
      <div className="mt-12">
        <p
          data-reveal
          data-reveal-order={1}
          className="mb-4 font-mono text-[10.5px] uppercase tracking-[0.16em]"
          style={{ color: "var(--m-eyebrow)" }}
        >
          Six more, compact
        </p>
        <ul className="divide-y" style={{ borderColor: "var(--m-border)" }}>
          {LIST.map((s, i) => (
            <ListRow key={s.itemTypeKey} shape={s} order={i % 4} />
          ))}
        </ul>
      </div>

      <p
        data-reveal
        data-reveal-order={3}
        className="mt-10 max-w-[64ch] text-[13px] leading-relaxed"
        style={{ color: "var(--m-fg-soft)" }}
      >
        Catalog editor accepts any shape. If your business doesn&apos;t
        appear above, the same backbone carries it — define your item
        type, declare your attributes, run your first order.
      </p>
    </MarketingSection>
  );
}

/* ─────────── lead + list primitives ──────────────────────────────────── */

function LeadRow({
  shape,
  withDivider,
}: {
  shape: CommerceShape;
  withDivider: boolean;
}) {
  return (
    <div
      className="grid grid-cols-1 gap-x-10 gap-y-5 px-6 py-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] lg:items-baseline"
      style={
        withDivider
          ? { borderBottom: "1px solid var(--m-border)" }
          : undefined
      }
    >
      <div>
        <h3 className="text-[18px] font-semibold tracking-tight">
          {shape.vertical}
        </h3>
        {shape.blurb ? (
          <p
            className="mt-2 max-w-[44ch] text-[13.5px] leading-relaxed"
            style={{ color: "var(--m-fg-soft)" }}
          >
            {shape.blurb}
          </p>
        ) : null}
      </div>
      <dl className="font-mono text-[12px] space-y-1.5">
        <SpecRow k="itemType" v={shape.itemTypeKey} emphasis />
        <SpecRow k="attributes" v={shape.attrs.join(" · ")} />
        <SpecRow k="evidence" v={shape.evidence} />
      </dl>
    </div>
  );
}

function SpecRow({
  k,
  v,
  emphasis,
}: {
  k: string;
  v: string;
  emphasis?: boolean;
}) {
  return (
    <div className="grid grid-cols-[5.5rem_1fr] items-baseline gap-x-3">
      <dt
        className="text-[11px]"
        style={{ color: "var(--m-eyebrow)" }}
      >
        {k}
      </dt>
      <dd
        className={emphasis ? "" : ""}
        style={
          emphasis ? undefined : { color: "var(--m-fg-soft)" }
        }
      >
        {v}
      </dd>
    </div>
  );
}

function ListRow({
  shape,
  order,
}: {
  shape: CommerceShape;
  order: number;
}) {
  return (
    <li
      data-reveal
      data-reveal-order={2 + order}
      className="grid grid-cols-1 items-baseline gap-x-6 gap-y-1 py-3 md:grid-cols-[7rem_minmax(0,9rem)_minmax(0,1fr)_minmax(0,1.1fr)]"
    >
      <span className="text-[13px] font-medium">{shape.vertical}</span>
      <span
        className="font-mono text-[11.5px]"
        style={{ color: "var(--m-eyebrow)" }}
      >
        {shape.itemTypeKey}
      </span>
      <span
        className="font-mono text-[11.5px] truncate"
        style={{ color: "var(--m-fg-soft)" }}
      >
        {shape.attrs.join(" · ")}
      </span>
      <span
        className="font-mono text-[11.5px]"
        style={{ color: "var(--m-fg-soft)" }}
      >
        {shape.evidence}
      </span>
    </li>
  );
}
