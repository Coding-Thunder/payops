import { MarketingSection, AccentWord } from "../section";

/**
 * Commerce Shapes — the "is this for my business?" chapter.
 *
 * Eight verticals shown as compact spec cards. Each card carries
 * three rows of mono text — itemType key, defining attributes, and
 * evidence shape — matching how PayOps actually models commerce
 * (see `ItemType.attributeSchema` in `src/server/db/models/item-type.model.ts`).
 *
 * Deliberately NOT a logo wall, NOT an industries-we-serve grid. The
 * content is data-shape, not industry-icon. Dark "graphite" theme
 * frames it as a developer-doc pause mid-page.
 */

interface CommerceShape {
  vertical: string;
  itemTypeKey: string;
  attrs: string[];
  evidence: string;
}

const SHAPES: CommerceShape[] = [
  {
    vertical: "Retail",
    itemTypeKey: "product",
    attrs: ["sku", "size", "color", "image"],
    evidence: "gateway receipt + delivery proof",
  },
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
    evidence: "pre/post photos + customer sign-off",
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
    evidence: "completion timestamp + customer signature",
  },
  {
    vertical: "Equipment",
    itemTypeKey: "rental_booking",
    attrs: ["asset_id", "starts_at", "ends_at"],
    evidence: "condition photos + handover log",
  },
  {
    vertical: "B2B",
    itemTypeKey: "net_invoice",
    attrs: ["po_number", "terms_days", "contract_ref"],
    evidence: "PO match + remittance trail",
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
          PayOps stores commerce as three primitives —{" "}
          <span className="font-mono text-current">item types</span>{" "}
          (what you sell),{" "}
          <span className="font-mono text-current">orders</span>{" "}
          (what was bought), and{" "}
          <span className="font-mono text-current">evidence</span>{" "}
          (what happened). The schema for each is yours. No vertical
          assumptions baked into the core. Eight verticals are sketched
          below; the same primitives carry custom commerce shapes that
          don&apos;t have an industry label yet.
        </>
      }
    >
      <p
        data-reveal
        data-reveal-order={0}
        className="mb-6 font-mono text-[10.5px] uppercase tracking-[0.18em]"
        style={{ color: "var(--m-eyebrow)" }}
      >
        itemType · defining attributes · evidence shape
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {SHAPES.map((s, i) => (
          <ShapeCard key={s.itemTypeKey} shape={s} order={i % 4} />
        ))}
      </div>

      <p
        data-reveal
        data-reveal-order={3}
        className="mt-8 max-w-2xl text-[12.5px] leading-relaxed"
        style={{ color: "var(--m-fg-soft)" }}
      >
        Catalog editor accepts any shape. If your business doesn&apos;t
        appear above, the same backbone carries it — define your item
        type, declare your attributes, run your first order.
      </p>
    </MarketingSection>
  );
}

function ShapeCard({
  shape,
  order,
}: {
  shape: CommerceShape;
  order: number;
}) {
  return (
    <div
      data-reveal
      data-reveal-order={order}
      className="group relative overflow-hidden rounded-2xl border p-5 transition-transform hover:-translate-y-px"
      style={{
        borderColor: "var(--m-border)",
        background: "var(--m-surface)",
      }}
    >
      {/* Hairline top accent on hover — same micro-detail as other
          bentos in the page so the chapter feels native. */}
      <span
        aria-hidden
        className="absolute inset-x-0 top-0 h-px opacity-0 transition-opacity group-hover:opacity-100"
        style={{
          background:
            "linear-gradient(90deg, transparent 0%, var(--m-eyebrow) 50%, transparent 100%)",
        }}
      />
      <p className="text-[13px] font-semibold tracking-tight">
        {shape.vertical}
      </p>
      <dl className="mt-3 space-y-2 font-mono text-[11.5px]">
        <Row label="itemType">
          <span className="text-current">{shape.itemTypeKey}</span>
        </Row>
        <Row label="attrs">
          <span style={{ color: "var(--m-fg-soft)" }}>
            {shape.attrs.join(", ")}
          </span>
        </Row>
        <Row label="evidence">
          <span style={{ color: "var(--m-fg-soft)" }}>
            {shape.evidence}
          </span>
        </Row>
      </dl>
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[68px_1fr] items-baseline gap-2">
      <dt
        className="uppercase tracking-[0.12em] text-[10px]"
        style={{ color: "var(--m-eyebrow)" }}
      >
        {label}
      </dt>
      <dd className="leading-snug">{children}</dd>
    </div>
  );
}
