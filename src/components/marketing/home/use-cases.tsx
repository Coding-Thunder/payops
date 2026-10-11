import {
  Reveal,
  Section,
  SectionHead,
} from "@/components/marketing/home/primitives";

/**
 * Who this is for.
 *
 * ── Why rows and not persona cards ───────────────────────────────────────
 *
 * The default treatment here is nine cards with an icon and a job title, which
 * tells a visitor nothing they did not already know about themselves. What
 * actually qualifies a reader is the *operational* detail: the specific thing
 * their business does after the money arrives. So each row names the job and
 * then the thing the record has to hold for that job, which is the part a
 * reader either recognises or doesn't.
 *
 * The qualifying sentence under the heading is doing real work too: TraceTxn
 * suits businesses that deliver *after* payment. A shop that takes a payment
 * and ships a box does not need this. Saying so filters the wrong visitors
 * out, which is more useful than another card.
 */

const AUDIENCES = [
  {
    who: "Marketing agencies",
    need: "Retainers and one-off campaigns against the same client, with the invoice history to match.",
  },
  {
    who: "SEO agencies",
    need: "Monthly deliverables and audits per client, and which service line actually earns.",
  },
  {
    who: "Software development agencies",
    need: "Staged builds where each stage is quoted, invoiced and delivered separately.",
  },
  {
    who: "AI automation agencies",
    need: "Scoped builds plus ongoing support, kept distinguishable on one record.",
  },
  {
    who: "Design studios",
    need: "Concepts, revision rounds and final files, with the version they signed off.",
  },
  {
    who: "Video production teams",
    need: "Deposits, delivery milestones and large files tied to the order that paid for them.",
  },
  {
    who: "Consultants",
    need: "Engagements billed in stages, with the agreement and correspondence on file.",
  },
  {
    who: "Freelancers",
    need: "One place that remembers every client, so nothing depends on memory.",
  },
  {
    who: "Webflow + Shopify developers",
    need: "Build, launch and maintenance treated as separate orders on one client.",
  },
];

export function UseCases() {
  return (
    <Section id="use-cases">
      <Reveal>
        <SectionHead
          eyebrow="Who it is for"
          title="Built for businesses that deliver work after the payment."
          copy="If the transaction is the start of the job rather than the end of it, the client record has to hold both. That is the shape TraceTxn is built around."
        />
      </Reveal>

      <Reveal delay={0.06}>
        <ul className="mt-11 grid gap-px overflow-hidden rounded-lg border border-[#E2E8F0] bg-[#E9EFF6] sm:grid-cols-2 lg:grid-cols-3">
          {AUDIENCES.map((a) => (
            <li key={a.who} className="bg-white px-4 py-4">
              <div className="text-[13px] font-semibold text-[#0A1128]">
                {a.who}
              </div>
              <p className="mt-1.5 text-[12.5px] leading-[1.55] text-[#4A5568]">
                {a.need}
              </p>
            </li>
          ))}
        </ul>
      </Reveal>

      <Reveal delay={0.1}>
        <p className="mt-6 max-w-[62ch] text-[13px] leading-relaxed text-[#64748B]">
          Less of a fit: businesses where payment is the end of the
          relationship. If nothing happens after the money arrives, there is no
          history to keep and TraceTxn has little to offer you.
        </p>
      </Reveal>
    </Section>
  );
}
