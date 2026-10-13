import {
  LiveDot,
  ProductFrame,
  Reveal,
  Section,
  SectionHead,
  StatusBadge,
  Td,
  Th,
} from "@/components/marketing/home/primitives";

/**
 * The full-width showcase: the whole record on one screen.
 *
 * The walkthrough above shows six capabilities one at a time, which is the
 * right way to explain them and the wrong way to show what the product
 * actually feels like. This section exists to make the point the individual
 * blocks cannot: all of it is one screen, at once.
 *
 * ── On the callouts ──────────────────────────────────────────────────────
 *
 * Annotated screenshots usually fail because the annotations win — a dozen
 * numbered pills and leader lines, and the eye reads the labels instead of
 * the interface. So there are four, they sit outside the frame on wide
 * viewports, and they disappear entirely below `lg` rather than reflowing on
 * top of the screen they are supposed to be describing.
 *
 * ── On sharing a route label with the hero ──────────────────────────────
 *
 * Both frames read `/app/customers/northwind-studio`, which is correct —
 * it is the same route. They are not duplicates: the hero shows it as the
 * product actually renders it (a tab strip with Timeline selected, matching
 * `Tabs defaultValue="timeline"` in `app/customers/[id]`), while this one
 * flattens several tabs into one view to make the "one record" point. That
 * flattening is a composite, so the caption says so instead of implying the
 * product shows all of it at once.
 */

const CALLOUTS = [
  {
    n: "01",
    label: "Client profile",
    copy: "Who they are, and the balance outstanding right now.",
  },
  {
    n: "02",
    label: "Timeline",
    copy: "Every order, invoice, payment, file and sent email, in sequence.",
  },
  {
    n: "03",
    label: "Orders + invoices",
    copy: "The transaction and its delivery stage on one row.",
  },
  {
    n: "04",
    label: "Files + notes",
    copy: "The evidence, attached to the thing it is evidence for.",
  },
];

export function UnifiedWorkspace() {
  return (
    <Section id="workspace" className="pt-4 sm:pt-6">
      <Reveal>
        <SectionHead
          align="center"
          eyebrow="The whole record"
          title="Everything your team needs to know about a client. One screen."
          copy="No tab-switching, no reconstructing, no asking the person who owns the account."
        />
      </Reveal>

      <div className="mt-12 grid gap-8 lg:grid-cols-[minmax(0,1fr)_236px] lg:gap-10">
        <Reveal className="min-w-0">
          <ProductFrame label="/app/customers/northwind-studio" live>
            {/* 01 · profile */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#E9EFF6] px-4 py-3">
              <div className="flex items-center gap-2.5">
                <span className="flex size-8 items-center justify-center rounded bg-[var(--brand-blue-soft)] font-display text-[12px] font-semibold text-[#0052D6]">
                  NS
                </span>
                <div>
                  <div className="text-[13.5px] font-semibold text-[#0F172A]">
                    Northwind Studio
                  </div>
                  <div className="font-mono text-[10.5px] text-[#64748B]">
                    ops@northwind.studio · client since Nov 2025
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-4">
                <div className="text-right">
                  <div className="text-[9.5px] font-semibold uppercase tracking-[0.1em] text-[#64748B]">
                    Outstanding
                  </div>
                  <div className="font-display text-[15px] font-semibold tabular-nums text-[#92610A]">
                    £1,800
                  </div>
                </div>
                <StatusBadge tone="live">active</StatusBadge>
              </div>
            </div>

            <div className="grid lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
              {/* 02 · timeline */}
              <div className="border-[#E9EFF6] lg:border-r">
                <div className="flex items-center justify-between border-b border-[#E9EFF6] px-4 py-2">
                  <span className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[#64748B]">
                    Timeline
                  </span>
                  <span className="inline-flex items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-[0.08em] text-[#047857]">
                    <LiveDot />
                    updating
                  </span>
                </div>
                <ul className="divide-y divide-[#F1F5F9]">
                  {[
                    ["09:14", "Payment confirmed · INV-0114", "paid", "PAID"],
                    ["Mar 3", "Invoice emailed to ops@", "info", "SENT"],
                    ["Mar 1", "Stage 2 → In production", "pending", "WIP"],
                    ["Feb 28", "brand-pack-v3.zip uploaded", "info", "FILE"],
                    ["Feb 12", "Scope v3 signed", "paid", "AGREED"],
                  ].map(([when, what, tone, badge]) => (
                    <li key={what} className="flex items-start gap-3 px-4 py-2">
                      <span className="mt-[2px] w-[44px] shrink-0 font-mono text-[10px] tabular-nums text-[#64748B]">
                        {when}
                      </span>
                      <span className="min-w-0 flex-1 text-[12px] leading-snug text-[#0F172A]">
                        {what}
                      </span>
                      <StatusBadge
                        tone={tone as "paid" | "pending" | "info"}
                        className="shrink-0"
                      >
                        {badge}
                      </StatusBadge>
                    </li>
                  ))}
                </ul>
              </div>

              {/* 03 · orders  +  04 · files & notes */}
              <div className="divide-y divide-[#E9EFF6]">
                <div>
                  <div className="border-b border-[#E9EFF6] px-4 py-2 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[#64748B]">
                    Orders
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse">
                      <thead>
                        <tr>
                          <Th>Ref</Th>
                          <Th>Stage</Th>
                          <Th right>Amount</Th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <Td mono strong>
                            #1042
                          </Td>
                          <Td>
                            <StatusBadge tone="paid">paid</StatusBadge>
                          </Td>
                          <Td right mono strong>
                            £4,000
                          </Td>
                        </tr>
                        <tr>
                          <Td mono strong>
                            #1051
                          </Td>
                          <Td>
                            <StatusBadge tone="pending">pending</StatusBadge>
                          </Td>
                          <Td right mono strong>
                            £1,800
                          </Td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>

                <div>
                  <div className="border-b border-[#E9EFF6] px-4 py-2 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[#64748B]">
                    Files &amp; notes
                  </div>
                  <ul className="divide-y divide-[#F1F5F9]">
                    {[
                      ["scope-v3-signed.pdf", "agreement"],
                      ["brand-pack-v3.zip", "order #1042"],
                      ["Wants the deck before Friday", "note"],
                    ].map(([name, meta]) => (
                      <li
                        key={name}
                        className="flex items-center gap-2 px-4 py-[9px]"
                      >
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[#0F172A]">
                          {name}
                        </span>
                        <span className="shrink-0 text-[10px] text-[#64748B]">
                          {meta}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>

            <div className="border-t border-[#E9EFF6] bg-[#F8FAFC] px-4 py-2 text-[10.5px] text-[#64748B]">
              Illustrative, and a composite: the record&apos;s timeline, orders
              and files are tabs in the product, shown together here to make
              the point. Not a customer&apos;s data.
            </div>
          </ProductFrame>
        </Reveal>

        {/* Callouts. Hidden below lg so they never overlay the screen. */}
        <Reveal delay={0.08} className="hidden lg:block">
          <ul className="flex flex-col gap-5">
            {CALLOUTS.map((c) => (
              <li key={c.n} className="border-l-2 border-[var(--brand-blue)] pl-3.5">
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-[10px] tabular-nums text-[var(--brand-blue)]">
                    {c.n}
                  </span>
                  <span className="text-[12.5px] font-semibold text-[#0A1128]">
                    {c.label}
                  </span>
                </div>
                <p className="mt-1 text-[12px] leading-snug text-[#4A5568]">
                  {c.copy}
                </p>
              </li>
            ))}
          </ul>
        </Reveal>
      </div>
    </Section>
  );
}
