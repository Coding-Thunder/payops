"use client";

import { LinkIcon, SearchIcon, InfinityIcon, type LucideIcon } from "lucide-react";

import { Reveal, Eyebrow } from "./primitives";

const PILLARS: { Icon: LucideIcon; title: string; body: string }[] = [
  {
    Icon: LinkIcon,
    title: "Everything connected",
    body: "Invoices, payments, approvals, files, notes and agreements attach to the client they belong to — automatically.",
  },
  {
    Icon: SearchIcon,
    title: "Instantly searchable",
    body: "Search a name and the whole relationship opens: what was agreed, what was billed, what was approved, and when.",
  },
  {
    Icon: InfinityIcon,
    title: "Permanent by default",
    body: "Nothing ages out. The record is still there a year later — when the client comes back and the question gets hard.",
  },
];

/**
 * The solution — stated plainly, once. We resist listing features here;
 * the demo that follows does the showing. What's not the product is as
 * important as what is.
 */
export function Solution() {
  return (
    <section className="relative border-t border-white/8">
      <div className="mx-auto max-w-[1140px] px-6 py-24 sm:py-28 lg:px-8">
        <div className="mx-auto max-w-3xl text-center">
          <Reveal>
            <Eyebrow className="justify-center">The solution</Eyebrow>
          </Reveal>
          <Reveal delay={0.05}>
            <h2 className="mt-5 font-display text-[34px] font-semibold leading-[1.08] tracking-[-0.028em] text-white sm:text-[46px]">
              Give every client one
              <br className="hidden sm:block" /> permanent, searchable record.
            </h2>
          </Reveal>
          <Reveal delay={0.1}>
            <p className="mx-auto mt-6 max-w-xl text-[16.5px] leading-relaxed text-white/60">
              Not a CRM. Not a project tool. Not accounting software. A single
              place where the full history of a client relationship lives — so
              you never have to reconstruct it again.
            </p>
          </Reveal>
        </div>

        <div className="mt-16 grid gap-4 sm:grid-cols-3">
          {PILLARS.map((p, i) => (
            <Reveal key={p.title} delay={0.06 * i}>
              <div className="h-full rounded-2xl border border-white/10 bg-white/[0.02] p-6">
                <span className="grid size-10 place-items-center rounded-xl bg-emerald-400/10 text-emerald-300 ring-1 ring-inset ring-emerald-400/20">
                  <p.Icon className="size-5" />
                </span>
                <h3 className="mt-5 font-display text-[17px] font-semibold text-white">
                  {p.title}
                </h3>
                <p className="mt-2 text-[14px] leading-relaxed text-white/55">
                  {p.body}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
