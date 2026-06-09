/**
 * Audience region, "who it's for".
 *
 * Leads with the digital-commerce framing (Shopify, e-commerce, B2B
 * SaaS, agencies, productized consulting) but keeps the schema-ledger
 * proof broad: item type, attributes, and evidence shape per business
 * type. The breadth is the point, the same backbone carries physical
 * commerce too, so the positioning never collapses to "Shopify-only".
 *
 * This block owns the verticals story for the page; the Integrity
 * region stays focused on security + compliance, no duplicate ledger.
 */

const SHAPES: Array<{
  vertical: string;
  itemTypeKey: string;
  attrs: string;
  evidence: string;
}> = [
  {
    vertical: "Shopify / E-commerce",
    itemTypeKey: "order_line",
    attrs: "sku · variant · fulfillment",
    evidence: "gateway receipt + delivery proof",
  },
  {
    vertical: "B2B SaaS",
    itemTypeKey: "subscription",
    attrs: "plan · seats · billing_period",
    evidence: "invoice + consent-to-charge trail",
  },
  {
    vertical: "Agency",
    itemTypeKey: "engagement",
    attrs: "scope · milestone · rate",
    evidence: "signed SOW + delivery sign-off",
  },
  {
    vertical: "Productized consulting",
    itemTypeKey: "package",
    attrs: "deliverable · revision_cap · term",
    evidence: "acceptance + completion record",
  },
  {
    vertical: "Retail / DTC",
    itemTypeKey: "product",
    attrs: "sku · size · color · image",
    evidence: "gateway receipt + delivery proof",
  },
  {
    vertical: "B2B invoicing",
    itemTypeKey: "net_invoice",
    attrs: "po_number · terms_days · contract_ref",
    evidence: "PO match + remittance trail",
  },
];

export function AudienceRegion() {
  return (
    <section id="audience" className="scroll-mt-20 pt-20 sm:pt-28">
      <div className="max-w-3xl">
        <p className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted-foreground">
          Who it&apos;s for
        </p>
        <h2 className="mt-3 font-display text-[clamp(1.7rem,3.6vw,2.6rem)] font-medium leading-[1.1] tracking-[-0.02em]">
          Built for Shopify, e-commerce, and{" "}
          <span className="font-semibold text-[color:var(--brand-emerald)]">
            modern digital engines.
          </span>
        </h2>
        <p className="mt-5 text-[14.5px] leading-relaxed text-muted-foreground">
          Whether you are scaling a Shopify storefront, a B2B SaaS platform,
          a high-ticket agency, or a productized consulting business, if your
          payment records are disconnected from your application logs, you
          are bleeding revenue.
        </p>
      </div>

      {/* Schema ledger, the same backbone reshaped per business type.
          itemType · attributes · evidence, proof the model bends without
          locking the page into a single vertical. */}
      <div className="mt-12">
        <div className="flex items-baseline justify-between border-b border-border pb-2">
          <h3 className="text-[13px] font-semibold tracking-tight">
            One backbone, shaped to your business
          </h3>
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
            itemType · attributes · evidence
          </span>
        </div>
        <ul className="divide-y divide-border">
          {SHAPES.map((s) => (
            <li
              key={s.itemTypeKey}
              className="grid grid-cols-1 items-baseline gap-x-6 gap-y-1 py-2.5 md:grid-cols-[10rem_minmax(0,10rem)_minmax(0,1fr)_minmax(0,1.1fr)]"
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
          Not listed above? The same backbone carries it, the catalog editor
          accepts any shape. Define your item type, declare your attributes,
          run your first order, and every payment record stays anchored to
          the application event that produced it.
        </p>
      </div>
    </section>
  );
}
