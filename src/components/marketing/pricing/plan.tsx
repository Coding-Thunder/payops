"use client";

import Link from "next/link";
import { ArrowRightIcon, CheckIcon } from "lucide-react";

import { Reveal } from "@/components/marketing/home/primitives";

/**
 * Single beta plan card. No tiers, no comparison table — the whole offer is
 * one line: $0 during beta, with access to the core TraceTxn experience.
 *
 * The feature list is exactly what's in the beta product today. We don't
 * pad it with roadmap items, and we don't dress "free" up as a limited-time
 * deal — it's free because the product is still being built.
 */

/** Everything a beta workspace gets. These are real, shipped surfaces. */
const INCLUDED = [
  "Client records",
  "Client timeline",
  "Invoices",
  "Payment tracking",
  "Client consent records",
  "Files and documents",
  "Notes",
  "Search",
  "Import existing clients",
  "Export your data",
] as const;

export function PricingPlan() {
  return (
    <section className="relative border-t border-white/8">
      <div className="mx-auto max-w-[1140px] px-6 py-20 sm:py-24 lg:px-8">
        <Reveal className="mx-auto max-w-[460px]">
          <div className="relative overflow-hidden rounded-3xl border border-white/12 bg-[#0b0d10] p-8 sm:p-10">
            {/* quiet emerald wash at the top — the only accent on the card */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 top-0 h-40"
              style={{
                background:
                  "radial-gradient(60% 100% at 50% 0%, rgba(52,211,153,0.10), transparent 70%)",
              }}
            />

            <div className="relative">
              <span className="inline-flex items-center rounded-full border border-emerald-400/25 bg-emerald-400/10 px-3 py-1 text-[11.5px] font-semibold uppercase tracking-[0.14em] text-emerald-300">
                Private Beta
              </span>

              <div className="mt-6 flex items-baseline gap-2">
                <span className="font-display text-[56px] font-semibold leading-none tracking-[-0.03em] text-white">
                  $0
                </span>
              </div>
              <p className="mt-2 text-[14px] text-white/50">Free during beta</p>

              <Link
                href="/signup"
                className="group mt-7 inline-flex h-11 w-full items-center justify-center gap-1.5 rounded-xl bg-white text-[14px] font-semibold text-[#08090b] transition-transform duration-150 hover:bg-white/90 active:translate-y-px"
              >
                Join the beta
                <ArrowRightIcon className="size-4 transition-transform duration-200 group-hover:translate-x-0.5" />
              </Link>
              <p className="mt-3 text-center text-[12.5px] text-white/35">
                No credit card required.
              </p>

              <div className="mt-8 border-t border-white/8 pt-7">
                <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-white/40">
                  What&apos;s included
                </p>
                <ul className="mt-5 grid gap-3">
                  {INCLUDED.map((feature) => (
                    <li
                      key={feature}
                      className="flex items-center gap-3 text-[14.5px] text-white/80"
                    >
                      <span className="grid size-5 shrink-0 place-items-center rounded-full bg-emerald-400/10 ring-1 ring-inset ring-emerald-400/25">
                        <CheckIcon className="size-3 text-emerald-300" />
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
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6">
            <h2 className="font-display text-[16.5px] font-semibold text-white">
              What happens after beta?
            </h2>
            <p className="mt-2 text-[14px] leading-relaxed text-white/55">
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
