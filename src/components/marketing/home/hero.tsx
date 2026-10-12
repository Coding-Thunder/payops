
import {
  LiveDot,
  ProductFrame,
  StatusBadge,
  Td,
  Th,
} from "@/components/marketing/home/primitives";

/**
 * Hero.
 *
 * ── Why nothing here animates in ─────────────────────────────────────────
 *
 * No `Reveal`. Every other section fades up on scroll; the hero must be
 * complete in the first painted frame, because that frame is what a social
 * card, a Lighthouse screenshot and a visitor who scrolls immediately all
 * get. A hero parked at `opacity: 0` waiting on an intersection observer is
 * a blank page to all three.
 *
 * ── Why the right column is a real screen ────────────────────────────────
 *
 * The visitor's first question is "what is this?", and a sentence answers it
 * far worse than the thing itself. So the right column is the client record —
 * header, tabs, timeline, money rail — at the application's real density,
 * built from the same primitives every section below uses. It is markup
 * rather than a PNG so it stays sharp, stays readable at 360px, and cannot
 * drift out of date the way a screenshot does.
 *
 * The figures are illustrative and labelled as such in the frame's own
 * chrome. They are not a customer's data and they are not presented as
 * results.
 */

const TIMELINE = [
  { when: "Today 09:14", what: "Invoice INV-0114 paid", tone: "paid" as const, badge: "PAID" },
  { when: "Mar 3", what: "Invoice INV-0114 sent · £4,000", tone: "info" as const, badge: "SENT" },
  { when: "Feb 28", what: "Brand pack v3 uploaded", tone: "info" as const, badge: "FILE" },
  { when: "Feb 24", what: "Stage 2 moved to In production", tone: "pending" as const, badge: "WIP" },
];

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      {/* A single, very low-contrast ledger grid behind the hero. It gives the
          canvas a hint of underlying structure without becoming decoration —
          the same device the document surfaces use. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.55]"
        style={{
          backgroundImage: "var(--doc-grid)",
          backgroundSize: "var(--doc-grid-size)",
          maskImage:
            "radial-gradient(120% 80% at 50% 0%, black 30%, transparent 75%)",
        }}
      />

      <div className="relative mx-auto grid w-full max-w-[1180px] items-center gap-12 px-6 pb-16 pt-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-14 lg:px-8 lg:pb-24 lg:pt-20">
        {/* ── Copy ───────────────────────────────────────────────────── */}
        <div className="min-w-0">
          <span className="inline-flex items-center gap-2 rounded border border-[var(--brand-blue-border)] bg-[var(--brand-blue-soft)] px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[#0052D6]">
            Client management for service businesses
          </span>

          <h1
            className="mt-6 font-display text-[36px] font-semibold leading-[1.08] tracking-[-0.03em] text-[#0A1128] sm:text-[46px] lg:text-[52px]"
            style={{ textWrap: "balance" }}
          >
            Your client workflow shouldn&apos;t live across five different
            tools.
          </h1>

          <p className="mt-5 max-w-[56ch] text-[16.5px] leading-[1.6] text-[#4A5568]">
            Stop switching between email, spreadsheets, a CRM, an invoicing
            tool, a payment dashboard and file storage. TraceTxn keeps each
            client&apos;s records, orders, files, payments and correspondence
            connected in one workspace.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <a
              href="#demo"
              className="inline-flex h-11 items-center justify-center rounded-md bg-[#0F172A] px-5 text-[14px] font-semibold text-white transition-colors hover:bg-[#1E293B] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-blue)]"
            >
              See the product
            </a>
          </div>

          {/* No "no credit card required" claim: there is no card at all,
              because the beta is free and billing is not wired up. And no
              invitation to sign up, because access is invite-only. */}
          <p className="mt-4 text-[13px] text-[#64748B]">
            TraceTxn is in private beta and currently invite-only.
          </p>

          {/* ── Micro-proof: everything stays attached to the client ──── */}
          <div className="mt-10 overflow-hidden rounded-lg border border-[#E2E8F0] bg-white">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-3.5 py-3">
              <span className="rounded bg-[#0F172A] px-1.5 py-[3px] font-mono text-[9.5px] font-semibold uppercase tracking-[0.1em] text-white">
                client
              </span>
              {["Timeline", "Orders", "Files", "Invoices", "Payments", "Notes"].map(
                (node, i) => (
                  <span key={node} className="flex items-center gap-2">
                    {i > 0 ? (
                      <span aria-hidden className="text-[#64748B]">
                        →
                      </span>
                    ) : null}
                    <span className="text-[12px] font-medium text-[#0F172A]">
                      {node}
                    </span>
                  </span>
                ),
              )}
              <span className="ml-auto hidden shrink-0 items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-[#047857] lg:inline-flex">
                <LiveDot />
                connected
              </span>
            </div>
          </div>
        </div>

        {/* ── Product ────────────────────────────────────────────────── */}
        <div className="min-w-0 lg:-mr-4">
          <ProductFrame label="/app/customers/northwind-studio" live>
            {/* Client header */}
            <div className="flex items-start justify-between gap-4 border-b border-[#E9EFF6] px-4 py-3.5">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="flex size-7 shrink-0 items-center justify-center rounded bg-[var(--brand-blue-soft)] font-display text-[11px] font-semibold text-[#0052D6]">
                    NS
                  </span>
                  <div className="min-w-0">
                    <div className="truncate text-[13.5px] font-semibold text-[#0F172A]">
                      Northwind Studio
                    </div>
                    <div className="truncate font-mono text-[10.5px] text-[#64748B]">
                      ops@northwind.studio
                    </div>
                  </div>
                </div>
              </div>
              <StatusBadge tone="live">active</StatusBadge>
            </div>

            {/* Tabs — the real information architecture of the record */}
            <div className="flex items-center gap-1 overflow-x-auto border-b border-[#E9EFF6] px-3 py-1.5">
              {["Timeline", "Orders", "Invoices", "Files", "Links", "Notes"].map(
                (t, i) => (
                  <span
                    key={t}
                    className={
                      i === 0
                        ? "rounded bg-[#0F172A] px-2.5 py-1 text-[11.5px] font-medium text-white"
                        : "rounded px-2.5 py-1 text-[11.5px] text-[#64748B]"
                    }
                  >
                    {t}
                  </span>
                ),
              )}
            </div>

            <div className="grid sm:grid-cols-[minmax(0,1fr)_168px]">
              {/* Timeline */}
              <div className="divide-y divide-[#F1F5F9] border-[#E9EFF6] sm:border-r">
                {TIMELINE.map((row) => (
                  <div
                    key={row.what}
                    className="flex items-start gap-3 px-4 py-2.5"
                  >
                    <span className="mt-[3px] w-[62px] shrink-0 font-mono text-[10px] tabular-nums text-[#64748B]">
                      {row.when}
                    </span>
                    <span className="min-w-0 flex-1 text-[12px] leading-snug text-[#0F172A]">
                      {row.what}
                    </span>
                    <StatusBadge tone={row.tone}>{row.badge}</StatusBadge>
                  </div>
                ))}
              </div>

              {/* Money rail */}
              <div className="divide-y divide-[#F1F5F9]">
                <div className="px-3.5 py-3">
                  <div className="text-[9.5px] font-semibold uppercase tracking-[0.1em] text-[#64748B]">
                    Billed
                  </div>
                  <div className="mt-1 font-display text-[17px] font-semibold tabular-nums text-[#0A1128]">
                    £12,400
                  </div>
                </div>
                <div className="px-3.5 py-3">
                  <div className="text-[9.5px] font-semibold uppercase tracking-[0.1em] text-[#64748B]">
                    Outstanding
                  </div>
                  <div className="mt-1 font-display text-[17px] font-semibold tabular-nums text-[#92610A]">
                    £1,800
                  </div>
                </div>
                <div className="px-3.5 py-3">
                  <div className="text-[9.5px] font-semibold uppercase tracking-[0.1em] text-[#64748B]">
                    Open orders
                  </div>
                  <div className="mt-1 font-display text-[17px] font-semibold tabular-nums text-[#0A1128]">
                    2
                  </div>
                </div>
              </div>
            </div>

            {/* Orders table — the transaction half of the record */}
            <div className="overflow-x-auto border-t border-[#E9EFF6]">
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <Th>Order</Th>
                    <Th>Service</Th>
                    <Th>Status</Th>
                    <Th right>Amount</Th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <Td mono strong>
                      #1042
                    </Td>
                    <Td>Brand system · stage 2</Td>
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
                    <Td>Website build · deposit</Td>
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

            <div className="border-t border-[#E9EFF6] bg-[#F8FAFC] px-4 py-2 text-[10.5px] text-[#64748B]">
              Illustrative workspace — not a customer&apos;s data.
            </div>
          </ProductFrame>
        </div>
      </div>
    </section>
  );
}
