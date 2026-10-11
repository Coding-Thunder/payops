import Link from "next/link";

import {
  Reveal,
  Section,
  SectionHead,
  StatusBadge,
} from "@/components/marketing/home/primitives";

/**
 * Pricing.
 *
 * ── Why there are no tiers here ──────────────────────────────────────────
 *
 * TraceTxn is a free private beta. There is no subscription billing in the
 * application — the only Stripe integration is the one that lets a workspace
 * charge ITS OWN clients, using its own keys. So a three-tier card layout
 * with monthly prices would advertise a transaction the product cannot
 * complete, and would contradict /pricing, which states the same single offer
 * and deliberately commits to no future prices.
 *
 * This section therefore says exactly what is true: $0 during the beta, by
 * invitation, with paid plans acknowledged as a later thing and no numbers
 * attached. The card layout from the brief returns the day plans exist and can
 * actually be bought.
 *
 * ── Why the included list is what it is ──────────────────────────────────
 *
 * Every line is reachable by a signed-in user today. Deliberately absent:
 * approvals, e-signature, time tracking, proposals, forecasting, and anything
 * described as a "multi-gateway framework" — Stripe is the only payment
 * processor the code has (`PaymentProcessor` has exactly one member), and the
 * claim-discipline tests fail the build if the marketing copy drifts.
 */

const INCLUDED = [
  "One searchable record per client",
  "Client timeline of every order, invoice, payment and email",
  "Orders with a status workflow you configure",
  "Numbered invoices and receipts",
  "Card payments through your own Stripe account",
  "Contracts, files and links on the client record",
  "Templated client email, recorded against the client",
  "Analytics across revenue, conversion and outstanding",
  "Shared team workspaces with role-based access",
  "Tamper-evident audit trail",
];

export function BetaOffer() {
  return (
    <Section id="beta">
      <Reveal>
        <SectionHead
          align="center"
          eyebrow="Pricing"
          title="Start organising your client workflow."
          copy="TraceTxn is in a private beta. It is free while that lasts, and we are not quoting prices we have not decided."
        />
      </Reveal>

      <div className="mx-auto mt-12 grid max-w-[940px] gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
        {/* The offer */}
        <Reveal>
          <div className="h-full overflow-hidden rounded-lg border border-[var(--brand-emerald-border)] bg-white shadow-[0_1px_2px_rgba(10,17,40,0.04),0_14px_34px_-20px_rgba(10,17,40,0.18)]">
            <div className="flex items-center justify-between border-b border-[#E9EFF6] bg-[var(--brand-emerald-soft)] px-5 py-2.5">
              <span className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[#047857]">
                Beta access
              </span>
              <StatusBadge tone="live">open</StatusBadge>
            </div>

            <div className="px-5 py-6">
              <div className="flex items-baseline gap-2">
                <span className="font-display text-[44px] font-semibold leading-none tracking-[-0.03em] text-[#0A1128]">
                  $0
                </span>
                <span className="text-[13.5px] text-[#64748B]">
                  while in private beta
                </span>
              </div>

              <p className="mt-4 text-[13.5px] leading-relaxed text-[#4A5568]">
                Access is by invitation while we are still shaping the product
                around how service businesses actually work. Join the list and
                we will be in touch — no card, and nothing to cancel.
              </p>

              <Link
                href="/waitlist"
                className="mt-6 inline-flex h-11 w-full items-center justify-center rounded-md bg-[#0F172A] px-5 text-[14px] font-semibold text-white transition-colors hover:bg-[#1E293B] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-blue)]"
              >
                Join the beta
              </Link>

              <p className="mt-4 text-[12px] leading-relaxed text-[#64748B]">
                Paid plans will come later. When they do, anyone already using
                TraceTxn will hear it from us first — not from a billing email.
              </p>
            </div>
          </div>
        </Reveal>

        {/* What's included */}
        <Reveal delay={0.06}>
          <div className="h-full overflow-hidden rounded-lg border border-[#E2E8F0] bg-white">
            <div className="border-b border-[#E9EFF6] bg-[#F8FAFC] px-5 py-2.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[#64748B]">
              Included, and working today
            </div>
            <ul className="grid gap-2.5 px-5 py-5 sm:grid-cols-2">
              {INCLUDED.map((item) => (
                <li key={item} className="flex items-start gap-2">
                  <span
                    aria-hidden
                    className="mt-[6px] flex size-3.5 shrink-0 items-center justify-center rounded-full bg-[var(--brand-emerald-soft)] text-[8px] leading-none text-[#047857]"
                  >
                    ✓
                  </span>
                  <span className="text-[12.5px] leading-snug text-[#0F172A]">
                    {item}
                  </span>
                </li>
              ))}
            </ul>
            <div className="border-t border-[#E9EFF6] px-5 py-3.5">
              <p className="text-[12px] leading-relaxed text-[#64748B]">
                Your Stripe keys stay yours — payments move through your own
                account to your own bank. TraceTxn records the result, it does
                not sit in the money path.
              </p>
            </div>
          </div>
        </Reveal>
      </div>
    </Section>
  );
}
