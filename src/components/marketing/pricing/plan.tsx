"use client";

import { CheckIcon } from "lucide-react";

import { Reveal } from "@/components/marketing/home/primitives";

/**
 * Single beta plan card. No tiers, no comparison table — the whole offer is
 * one line: $0 during beta, with access to the core TraceTxn experience.
 *
 * The feature list is exactly what's in the beta product today. We don't
 * pad it with roadmap items, and we don't dress "free" up as a limited-time
 * deal — it's free because the product is still being built.
 */

/**
 * Everything a beta workspace gets. These are real, shipped surfaces.
 *
 * "Import existing clients" was removed: there is no bulk importer — only the
 * export routes — so it promised a migration path that does not exist and
 * contradicted the homepage FAQ, which says so plainly.
 */
const INCLUDED = [
  "Client records",
  "Client timeline",
  "Invoices",
  "Payment tracking",
  "Client consent records",
  "Files and documents",
  "Notes",
  "Search",
  "Export your data",
] as const;

export function PricingPlan() {
  return (
    <section className="relative border-t border-[#E9EFF6]">
      <div className="mx-auto max-w-[1140px] px-6 py-20 sm:py-24 lg:px-8">
        <Reveal className="mx-auto max-w-[460px]">
          <div className="relative overflow-hidden rounded-3xl border border-[var(--brand-emerald-border)] bg-white p-8 shadow-[0_1px_2px_rgba(10,17,40,0.04),0_14px_34px_-20px_rgba(10,17,40,0.18)] sm:p-10">
            {/* quiet emerald wash at the top — the only accent on the card */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 top-0 h-40"
              style={{
                background:
                  "radial-gradient(60% 100% at 50% 0%, rgba(16,185,129,0.07), transparent 70%)",
              }}
            />

            <div className="relative">
              <span className="inline-flex items-center rounded-full border border-[var(--brand-emerald-border)] bg-[var(--brand-emerald-soft)] px-3 py-1 text-[11.5px] font-semibold uppercase tracking-[0.14em] text-[#047857]">
                Private Beta
              </span>

              <div className="mt-6 flex items-baseline gap-2">
                <span className="font-display text-[56px] font-semibold leading-none tracking-[-0.03em] text-[#0A1128]">
                  $0
                </span>
              </div>
              <p className="mt-2 text-[14px] text-[#64748B]">Free during beta</p>

              {/* No action here: the beta is invite-only, so a button would
                  promise something a visitor cannot complete. The card states
                  the terms and stops. */}
              <p className="mt-7 rounded-xl border border-[#E9EFF6] bg-[#F8FAFC] px-4 py-3 text-center text-[12.5px] leading-relaxed text-[#64748B]">
                Invite-only while TraceTxn is in private beta. No card, no
                charge.
              </p>

              <div className="mt-8 border-t border-[#E9EFF6] pt-7">
                <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-[#64748B]">
                  What&apos;s included
                </p>
                <ul className="mt-5 grid gap-3">
                  {INCLUDED.map((feature) => (
                    <li
                      key={feature}
                      className="flex items-center gap-3 text-[14.5px] text-[#4A5568]"
                    >
                      <span className="grid size-5 shrink-0 place-items-center rounded-full bg-[var(--brand-emerald-soft)] ring-1 ring-inset ring-[var(--brand-emerald-border)]">
                        <CheckIcon className="size-3 text-[#047857]" />
                      </span>
                      {feature}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </Reveal>

        {/* What happens after beta? — honest, no future prices, no promises. */}
        <Reveal delay={0.06} className="mx-auto mt-6 max-w-[460px]">
          <div className="rounded-2xl border border-[#E2E8F0] bg-white p-6">
            <h2 className="font-display text-[16.5px] font-semibold text-[#0A1128]">
              What happens after beta?
            </h2>
            <p className="mt-2 text-[14px] leading-relaxed text-[#4A5568]">
              We&apos;ll introduce paid plans later. If you&apos;re using
              TraceTxn during the beta, we&apos;ll let you know before anything
              changes.
            </p>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
