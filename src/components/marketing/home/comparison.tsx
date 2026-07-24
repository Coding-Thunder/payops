"use client";

import { CheckIcon, XIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Reveal, Eyebrow } from "./primitives";

const BEFORE = [
  "Open Gmail, search “invoice”, hope you used the right word",
  "Dig through Drive for the contract — v2 or v3?",
  "Scroll Slack for the “sounds good”",
  "Find the WhatsApp voice note that approved the design",
  "Cross-check Stripe for what actually got paid",
  "Rebuild the timeline in your head, and hope it holds up",
];

const AFTER = [
  "Search the client’s name",
  "Their record opens",
  "Invoices, payments, approvals and files — already there",
  "Read the timeline, dated and in order",
  "Send one link",
  "Get back to work",
];

/**
 * Before/after. The asymmetry is the argument: six anxious steps on the
 * left, six calm ones on the right that all happen in seconds.
 */
export function Comparison() {
  return (
    <section className="relative border-t border-white/8">
      <div className="mx-auto max-w-[1140px] px-6 py-24 sm:py-28 lg:px-8">
        <div className="mx-auto max-w-2xl text-center">
          <Reveal>
            <Eyebrow className="justify-center">The difference</Eyebrow>
          </Reveal>
          <Reveal delay={0.05}>
            <h2 className="mt-5 font-display text-[32px] font-semibold leading-[1.1] tracking-[-0.025em] text-white sm:text-[40px]">
              Same question. Two very different afternoons.
            </h2>
          </Reveal>
        </div>

        <div className="mt-14 grid gap-4 lg:grid-cols-2">
          {/* before */}
          <Reveal>
            <div className="h-full rounded-2xl border border-white/10 bg-white/[0.02] p-6 sm:p-7">
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-semibold uppercase tracking-[0.12em] text-white/45">
                  Today, across 8 tools
                </span>
                <span className="rounded-full bg-white/6 px-2.5 py-1 font-mono text-[11px] text-white/50">
                  ~30 min / question
                </span>
              </div>
              <ul className="mt-6 space-y-3">
                {BEFORE.map((b, i) => (
                  <li key={i} className="flex items-start gap-3">
                    <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-white/6 text-white/40">
                      <XIcon className="size-3" />
                    </span>
                    <span className="text-[14px] leading-snug text-white/55">
                      {b}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>

          {/* after */}
          <Reveal delay={0.08}>
            <div className="relative h-full overflow-hidden rounded-2xl border border-emerald-400/25 bg-emerald-400/[0.04] p-6 sm:p-7">
              <div
                aria-hidden
                className="pointer-events-none absolute -right-16 -top-16 size-48 rounded-full bg-emerald-400/10 blur-3xl"
              />
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-semibold uppercase tracking-[0.12em] text-emerald-300">
                  With one client record
                </span>
                <span className="rounded-full bg-emerald-400/15 px-2.5 py-1 font-mono text-[11px] text-emerald-200">
                  ~5 seconds
                </span>
              </div>
              <ul className="mt-6 space-y-3">
                {AFTER.map((a, i) => (
                  <li key={i} className="flex items-start gap-3">
                    <span
                      className={cn(
                        "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-emerald-400/20 text-emerald-300",
                      )}
                    >
                      <CheckIcon className="size-3" />
                    </span>
                    <span className="text-[14px] leading-snug text-white/80">
                      {a}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
