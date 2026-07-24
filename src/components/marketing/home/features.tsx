"use client";

import {
  ArchiveIcon,
  ClockIcon,
  DownloadIcon,
  ReceiptIcon,
  SearchIcon,
  UserSquareIcon,
  type LucideIcon,
} from "lucide-react";

import { Reveal, Eyebrow } from "./primitives";

const FEATURES: { Icon: LucideIcon; title: string; body: string }[] = [
  {
    Icon: UserSquareIcon,
    title: "One record per client",
    body: "Every invoice, payment, approval, file and note attaches to the right client automatically. Nothing lives on its own.",
  },
  {
    Icon: SearchIcon,
    title: "Search that finds it",
    body: "Type a name, an invoice number, an email or a phone number. The right record opens instantly — no folders to remember.",
  },
  {
    Icon: ClockIcon,
    title: "A timeline that never forgets",
    body: "A dated history of the whole relationship, from the first note to the final delivery. Scroll back anytime.",
  },
  {
    Icon: ReceiptIcon,
    title: "Money, in context",
    body: "See what was billed and what actually cleared, sitting right next to the work and approvals it paid for.",
  },
  {
    Icon: ArchiveIcon,
    title: "Approvals on the record",
    body: "Capture sign-offs and agreements so “we never approved that” always has a dated, specific answer.",
  },
  {
    Icon: DownloadIcon,
    title: "Yours to keep",
    body: "Export any client’s complete record whenever you want. No lock-in, no data held hostage, ever.",
  },
];

/**
 * Features, deliberately last-ish in the story and framed as outcomes,
 * not a spec sheet. Each line answers "what does this do for me."
 */
export function Features() {
  return (
    <section id="features" className="relative border-t border-white/8">
      <div className="mx-auto max-w-[1140px] px-6 py-24 sm:py-28 lg:px-8">
        <div className="max-w-2xl">
          <Reveal>
            <Eyebrow>What you get</Eyebrow>
          </Reveal>
          <Reveal delay={0.05}>
            <h2 className="mt-5 font-display text-[32px] font-semibold leading-[1.1] tracking-[-0.025em] text-white sm:text-[40px]">
              The whole relationship, on one page.
            </h2>
          </Reveal>
        </div>

        <div className="mt-14 grid gap-px overflow-hidden rounded-2xl border border-white/10 bg-white/8 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f, i) => (
            <Reveal key={f.title} delay={0.04 * (i % 3)} className="h-full">
              <div className="group h-full bg-[#0a0c0e] p-6 transition-colors duration-300 hover:bg-[#0f1114]">
                <span className="grid size-10 place-items-center rounded-xl bg-white/5 text-white/70 ring-1 ring-inset ring-white/8 transition-colors group-hover:text-emerald-300">
                  <f.Icon className="size-5" />
                </span>
                <h3 className="mt-5 font-display text-[16.5px] font-semibold text-white">
                  {f.title}
                </h3>
                <p className="mt-2 text-[14px] leading-relaxed text-white/55">
                  {f.body}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
