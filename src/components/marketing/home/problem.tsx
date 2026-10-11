import {
  Reveal,
  Section,
  SectionHead,
  StatusBadge,
} from "@/components/marketing/home/primitives";

/**
 * The problem: one client's record, split across six places.
 *
 * ── Why this is panels and not an illustration ───────────────────────────
 *
 * The usual version of this section is a diagram — tangled arrows on the left,
 * a tidy hub on the right. It communicates "messy vs clean" and nothing else.
 * The actual problem is more specific and more annoying than mess: each tool
 * holds a *true* fragment, none of them holds the whole, and the cost only
 * shows up when someone asks a question that spans two of them.
 *
 * So the left column names the tools and shows exactly which fragment each
 * one owns, and the bottom strip lists the questions that fall between them.
 * That is the part a visitor recognises from their own week.
 *
 * ── Why no competitor is criticised ──────────────────────────────────────
 *
 * Gmail, Sheets, Stripe and Drive are all good at the job each is doing here.
 * Nothing on this page says otherwise. The claim is narrower and defensible:
 * the client's history does not live in any of them, so it lives nowhere.
 */

const FRAGMENTS = [
  {
    tool: "Gmail",
    holds: "The scope change they agreed to in a reply",
    detail: "Thread, 14 messages",
  },
  {
    tool: "Google Sheets",
    holds: "Which stage each job is actually at",
    detail: "clients_2026.xlsx · last edit 9 days ago",
  },
  {
    tool: "Stripe",
    holds: "What has been paid, and what bounced",
    detail: "2 payments · 1 outstanding",
  },
  {
    tool: "Google Drive",
    holds: "The signed contract and the deliverables",
    detail: "/Clients/Northwind/final-v3-FINAL",
  },
  {
    tool: "A CRM",
    holds: "The contact, and a deal marked closed-won",
    detail: "Last activity: 4 months ago",
  },
  {
    tool: "WhatsApp",
    holds: "The thing they actually asked for on Friday",
    detail: "On one person's phone",
  },
];

/** The questions that need two systems at once, which is why nobody answers them. */
const UNANSWERABLE = [
  "What did we agree to deliver, exactly?",
  "Has stage two been paid for?",
  "Which contract version did they sign?",
  "What did we last tell them, and when?",
  "Why is this invoice still open?",
];

export function Problem() {
  return (
    <Section id="problem" className="pt-4 sm:pt-6">
      <Reveal>
        <SectionHead
          eyebrow="The operational problem"
          title={
            <>
              Your client data is scattered. Your workflow shouldn&apos;t be.
            </>
          }
          copy="Client context gets lost when orders, email, files, invoices, payments and notes each live somewhere else. Every tool holds a true fragment. None of them holds the client."
        />
      </Reveal>

      <div className="mt-12 grid gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] lg:gap-8">
        {/* ── Left: six tools, six fragments ────────────────────────── */}
        <Reveal className="min-w-0">
          <div className="overflow-hidden rounded-lg border border-[#E2E8F0] bg-white">
            <div className="flex items-baseline justify-between border-b border-[#E9EFF6] bg-[#F8FAFC] px-4 py-2.5">
              <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#64748B]">
                One client · six systems
              </span>
              <span className="font-mono text-[10.5px] text-[#64748B]">
                Northwind Studio
              </span>
            </div>

            <ul className="divide-y divide-[#F1F5F9]">
              {FRAGMENTS.map((f) => (
                <li
                  key={f.tool}
                  className="flex items-start gap-3 px-4 py-3"
                >
                  <span className="mt-[1px] w-[104px] shrink-0 text-[12px] font-semibold text-[#0F172A]">
                    {f.tool}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12.5px] leading-snug text-[#4A5568]">
                      {f.holds}
                    </span>
                    <span className="mt-0.5 block truncate font-mono text-[10.5px] text-[#64748B]">
                      {f.detail}
                    </span>
                  </span>
                </li>
              ))}
            </ul>

            <div className="border-t border-[#E9EFF6] bg-[#F8FAFC] px-4 py-3">
              <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#64748B]">
                Questions that need two of them at once
              </div>
              <ul className="mt-2.5 grid gap-1.5">
                {UNANSWERABLE.map((q) => (
                  <li
                    key={q}
                    className="flex items-start gap-2 text-[12.5px] text-[#4A5568]"
                  >
                    <span
                      aria-hidden
                      className="mt-[7px] size-1 shrink-0 rounded-full bg-[#CBD5E1]"
                    />
                    {q}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </Reveal>

        {/* ── Right: the same information, in one record ─────────────── */}
        <Reveal delay={0.08} className="min-w-0">
          <div className="overflow-hidden rounded-lg border border-[#E2E8F0] bg-white shadow-[0_1px_2px_rgba(10,17,40,0.04),0_12px_32px_-18px_rgba(10,17,40,0.16)]">
            <div className="flex items-baseline justify-between border-b border-[#E9EFF6] bg-[var(--brand-blue-soft)] px-4 py-2.5">
              <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#0052D6]">
                One client · one record
              </span>
              <StatusBadge tone="live">connected</StatusBadge>
            </div>

            <ul className="divide-y divide-[#F1F5F9]">
              {[
                ["Agreement", "Scope v3 · signed 12 Feb", "paid"],
                ["Orders", "#1042 stage 2 · #1051 deposit", "info"],
                ["Invoices", "INV-0114 settled · INV-0121 open", "pending"],
                ["Payments", "£10,600 received · £1,800 due", "paid"],
                ["Files", "Brand pack v3 · deliverables", "info"],
                ["Correspondence", "Last sent 3 Mar, by Priya", "info"],
              ].map(([label, value, tone]) => (
                <li key={label} className="flex items-center gap-3 px-4 py-3">
                  <span className="w-[108px] shrink-0 text-[12px] font-semibold text-[#0F172A]">
                    {label}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-[#4A5568]">
                    {value}
                  </span>
                  <StatusBadge
                    tone={tone as "paid" | "pending" | "info"}
                    className="shrink-0"
                  >
                    {tone === "paid" ? "ok" : tone === "pending" ? "open" : "on file"}
                  </StatusBadge>
                </li>
              ))}
            </ul>

            <div className="border-t border-[#E9EFF6] px-4 py-3.5">
              <p className="text-[12.5px] leading-relaxed text-[#4A5568]">
                Same facts. One place to read them, in the order they happened —
                so the answer to &ldquo;where are we with this client?&rdquo;
                takes one screen instead of six tabs.
              </p>
            </div>
          </div>
        </Reveal>
      </div>
    </Section>
  );
}
