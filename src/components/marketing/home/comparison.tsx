import {
  Reveal,
  Section,
  SectionHead,
} from "@/components/marketing/home/primitives";

/**
 * Differentiation, stated as a factual description of where things live.
 *
 * ── The rule for this section ────────────────────────────────────────────
 *
 * No competitor is named and no competitor is criticised. The left column
 * describes a scattered setup accurately — those tools each do their job
 * well — and the right column says where the same thing sits in TraceTxn.
 * Every right-hand cell is a capability a signed-in user can reach today.
 *
 * It deliberately does NOT claim to replace anything. A visitor's accounting
 * software, their project tool and their payment processor all stay; the
 * claim is only that the client's history stops being spread across them.
 *
 * The last row is the one that matters and is the reason the table exists:
 * nothing above it is novel on its own, and the difference is that they are
 * the same record rather than six exports that have to be reconciled.
 */

const ROWS: { facet: string; scattered: string; traceTxn: string }[] = [
  {
    facet: "Client record",
    scattered: "A CRM contact, plus a row in a spreadsheet",
    traceTxn: "One searchable record per client",
  },
  {
    facet: "Orders",
    scattered: "A project tool, or the spreadsheet",
    traceTxn: "Orders on the client, with a workflow you configure",
  },
  {
    facet: "Invoices",
    scattered: "Accounting software, numbered separately",
    traceTxn: "Numbered invoices raised from the order",
  },
  {
    facet: "Payments",
    scattered: "A gateway dashboard, matched by hand",
    traceTxn: "Confirmed payments matched to the order",
  },
  {
    facet: "Files",
    scattered: "Cloud storage, in a folder tree",
    traceTxn: "Attached to the client and the specific order",
  },
  {
    facet: "Correspondence",
    scattered: "Individual inboxes",
    traceTxn: "Templated client email, recorded on the record",
  },
  {
    facet: "Transaction history",
    scattered: "Reconstructed when somebody asks",
    traceTxn: "A timeline, in the order it happened",
  },
  {
    facet: "Evidence for a query",
    scattered: "Assembled under time pressure",
    traceTxn: "Already assembled, with an audit trail",
  },
];

export function Comparison() {
  return (
    <Section id="comparison">
      <Reveal>
        <SectionHead
          eyebrow="Where things live"
          title="One client workflow. Fewer disconnected systems."
          copy="Not a replacement for your accounting software, your project tool or your payment processor. The difference is that the client's history stops living in all of them at once."
        />
      </Reveal>

      <Reveal delay={0.06}>
        <div className="mt-11 overflow-x-auto rounded-lg border border-[#E2E8F0] bg-white">
          <table className="w-full min-w-[640px] border-collapse">
            <caption className="sr-only">
              Where each part of a client&apos;s record lives in a scattered
              setup, compared with TraceTxn.
            </caption>
            <thead>
              <tr>
                <th
                  scope="col"
                  className="w-[164px] border-b border-[#E9EFF6] bg-[#F8FAFC] px-4 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[#64748B]"
                >
                  &nbsp;
                </th>
                <th
                  scope="col"
                  className="border-b border-[#E9EFF6] bg-[#F8FAFC] px-4 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[#64748B]"
                >
                  Scattered across tools
                </th>
                <th
                  scope="col"
                  className="border-b border-[var(--brand-blue-border)] bg-[var(--brand-blue-soft)] px-4 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[#0052D6]"
                >
                  In TraceTxn
                </th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((r, i) => (
                <tr key={r.facet}>
                  <th
                    scope="row"
                    className="border-b border-[#F1F5F9] px-4 py-3 text-left align-top text-[12.5px] font-semibold text-[#0F172A]"
                  >
                    {r.facet}
                  </th>
                  <td className="border-b border-[#F1F5F9] px-4 py-3 align-top text-[12.5px] leading-snug text-[#64748B]">
                    {r.scattered}
                  </td>
                  <td
                    className={
                      // The last row carries the argument, so it is the only
                      // emphasised cell in the table.
                      i === ROWS.length - 1
                        ? "border-b border-[#F1F5F9] bg-[var(--brand-blue-soft)]/40 px-4 py-3 align-top text-[12.5px] font-medium leading-snug text-[#0A1128]"
                        : "border-b border-[#F1F5F9] px-4 py-3 align-top text-[12.5px] leading-snug text-[#0F172A]"
                    }
                  >
                    {r.traceTxn}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Reveal>
    </Section>
  );
}
