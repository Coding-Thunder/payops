"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRightIcon, QuoteIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Reveal, Eyebrow } from "./primitives";

interface UseCase {
  key: string;
  tab: string;
  who: string;
  situation: string;
  answer: string;
}

const CASES: UseCase[] = [
  {
    key: "web",
    tab: "Web design",
    who: "Web design agency",
    situation:
      "Six months after launch, the client insists the second landing page was “always included” and refuses the extra invoice.",
    answer:
      "Open their record. The signed agreement and the dated approval thread show exactly what the scope covered — and what was added later.",
  },
  {
    key: "brand",
    tab: "Branding",
    who: "Branding studio",
    situation:
      "A past client comes back wanting the source files and asks which logo direction they actually signed off on.",
    answer:
      "The Files tab holds the delivered brand pack; the timeline shows the exact direction they approved, on the exact date.",
  },
  {
    key: "seo",
    tab: "SEO",
    who: "SEO agency",
    situation:
      "The client questions the retainer and asks what you actually delivered last quarter.",
    answer:
      "The timeline lays out every deliverable, report and invoice from that period, dated — no digging, no defensiveness.",
  },
  {
    key: "marketing",
    tab: "Marketing",
    who: "Marketing agency",
    situation:
      "An account manager leaves and a new one inherits the client knowing none of the history.",
    answer:
      "The record is the handover: every past invoice, approval, file and note in one place they can read in five minutes.",
  },
  {
    key: "dev",
    tab: "Development",
    who: "Development shop",
    situation:
      "A client disputes a change-request charge, saying they never agreed to it.",
    answer:
      "The approval and the invoice sit side by side on the same timeline. The conversation ends in one link.",
  },
  {
    key: "free",
    tab: "Freelancer",
    who: "Freelancer",
    situation:
      "A client from last year messages “just a small change” — and you can barely remember the project.",
    answer:
      "Reopen their record and pick up where you left off: scope, rate, files and history all intact.",
  },
];

/**
 * Use cases as a recognition machine. Every tab is a specific, common
 * fight an agency has had — pick your kind, read your exact situation,
 * see how the record settles it.
 */
export function UseCases() {
  const [active, setActive] = useState(CASES[0].key);
  const current = CASES.find((c) => c.key === active) ?? CASES[0];

  return (
    <section id="use-cases" className="relative border-t border-white/8 bg-white/[0.015]">
      <div className="mx-auto max-w-[1140px] px-6 py-24 sm:py-28 lg:px-8">
        <div className="max-w-2xl">
          <Reveal>
            <Eyebrow>Sound familiar?</Eyebrow>
          </Reveal>
          <Reveal delay={0.05}>
            <h2 className="mt-5 font-display text-[32px] font-semibold leading-[1.1] tracking-[-0.025em] text-white sm:text-[40px]">
              You&apos;ve been in this exact situation.
            </h2>
          </Reveal>
          <Reveal delay={0.1}>
            <p className="mt-5 text-[16px] leading-relaxed text-white/60">
              Pick your kind of work. The fight is always the same shape — and
              it always comes down to one question: what actually happened?
            </p>
          </Reveal>
        </div>

        <Reveal delay={0.1}>
          <div className="mt-10 flex flex-wrap gap-2">
            {CASES.map((c) => (
              <button
                key={c.key}
                onClick={() => setActive(c.key)}
                className={cn(
                  "rounded-full border px-4 py-2 text-[13px] font-medium transition-colors",
                  active === c.key
                    ? "border-emerald-400/30 bg-emerald-400/10 text-white"
                    : "border-white/12 bg-white/[0.02] text-white/55 hover:border-white/25 hover:text-white",
                )}
              >
                {c.tab}
              </button>
            ))}
          </div>
        </Reveal>

        <Reveal delay={0.12}>
          <div className="mt-6 overflow-hidden rounded-2xl border border-white/12 bg-[#0c0e11] p-6 sm:p-8">
            <AnimatePresence mode="wait">
              <motion.div
                key={current.key}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                className="grid gap-8 lg:grid-cols-2"
              >
                <div>
                  <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-white/40">
                    {current.who}
                  </span>
                  <div className="mt-4 flex gap-3">
                    <QuoteIcon className="size-6 shrink-0 text-white/20" />
                    <p className="text-[19px] font-medium leading-snug text-white/90">
                      {current.situation}
                    </p>
                  </div>
                </div>
                <div className="rounded-xl border border-emerald-400/15 bg-emerald-400/[0.04] p-5">
                  <div className="flex items-center gap-2 text-[12px] font-medium uppercase tracking-[0.14em] text-emerald-300">
                    <ArrowRightIcon className="size-4" />
                    With TraceTxn
                  </div>
                  <p className="mt-3 text-[15.5px] leading-relaxed text-white/75">
                    {current.answer}
                  </p>
                </div>
              </motion.div>
            </AnimatePresence>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
