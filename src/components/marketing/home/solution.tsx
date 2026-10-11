import {
  Reveal,
  Section,
  SectionHead,
  StatusBadge,
} from "@/components/marketing/home/primitives";

/**
 * The solution, framed as a lifecycle rather than a feature list.
 *
 * The problem section above showed six tools each holding a fragment. The
 * honest answer to that is not "we have all those features too" — it is that
 * the fragments are stages of one sequence, and the record is what carries
 * context from each stage to the next.
 *
 * So this section is the sequence: enquiry → agreement → order → delivery →
 * invoice → payment → history. Each stage names what it writes to the record,
 * because "it's all in one place" means nothing until you can see what lands
 * there and when.
 *
 * Deliberately not a feature grid. The feature grid is the walkthrough below,
 * where each claim is attached to the screen that performs it.
 */

const LIFECYCLE = [
  {
    stage: "Enquiry",
    writes: "Client created, contact on file",
    tone: "info" as const,
  },
  {
    stage: "Agreement",
    writes: "Scope + contract attached to the client",
    tone: "info" as const,
  },
  {
    stage: "Order",
    writes: "What was bought, at what price",
    tone: "info" as const,
  },
  {
    stage: "Delivery",
    writes: "Stage moves through your own workflow",
    tone: "pending" as const,
  },
  {
    stage: "Invoice",
    writes: "Numbered invoice, sent and recorded",
    tone: "pending" as const,
  },
  {
    stage: "Payment",
    writes: "Confirmed by the gateway, matched to the order",
    tone: "paid" as const,
  },
  {
    stage: "History",
    writes: "The whole sequence, still readable in a year",
    tone: "paid" as const,
  },
];

export function Solution() {
  return (
    <Section id="solution" className="pt-4 sm:pt-6">
      <Reveal>
        <SectionHead
          eyebrow="The workspace"
          title="One workspace for the entire client lifecycle."
          copy="From the first enquiry through delivery and payment, every step writes to the same client record. Nobody has to remember to update it, because doing the work is what updates it."
        />
      </Reveal>

      <Reveal delay={0.06}>
        <ol className="mt-12 grid gap-px overflow-hidden rounded-lg border border-[#E2E8F0] bg-[#E9EFF6] sm:grid-cols-2 lg:grid-cols-4">
          {LIFECYCLE.map((s, i) => (
            <li key={s.stage} className="flex flex-col gap-2 bg-white p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[10px] tabular-nums text-[#64748B]">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <StatusBadge tone={s.tone}>
                  {s.tone === "paid"
                    ? "settled"
                    : s.tone === "pending"
                      ? "in flight"
                      : "on file"}
                </StatusBadge>
              </div>
              <div className="text-[13.5px] font-semibold text-[#0A1128]">
                {s.stage}
              </div>
              <div className="text-[12px] leading-snug text-[#4A5568]">
                {s.writes}
              </div>
            </li>
          ))}
          {/* Fills the 8th cell on a 4-up grid so the row closes cleanly
              rather than leaving a ragged hole. */}
          <li className="flex flex-col justify-center gap-1.5 bg-[#F8FAFC] p-4">
            <div className="text-[12.5px] font-semibold text-[#0A1128]">
              Nothing to reconcile
            </div>
            <div className="text-[12px] leading-snug text-[#4A5568]">
              One record, written by the work itself.
            </div>
          </li>
        </ol>
      </Reveal>
    </Section>
  );
}
