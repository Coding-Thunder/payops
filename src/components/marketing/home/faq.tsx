"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { PlusIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { FAQS } from "./faq-content";
import { Reveal, Eyebrow } from "./primitives";


export function Faq() {
  const [open, setOpen] = useState<number | null>(0);

  return (
    <section id="faq" className="relative border-t border-white/8 bg-white/[0.015]">
      <div className="mx-auto max-w-[820px] px-6 py-24 sm:py-28 lg:px-8">
        <div className="text-center">
          <Reveal>
            <Eyebrow className="justify-center">Questions</Eyebrow>
          </Reveal>
          <Reveal delay={0.05}>
            <h2 className="mt-5 font-display text-[32px] font-semibold leading-[1.1] tracking-[-0.025em] text-white sm:text-[40px]">
              The honest answers.
            </h2>
          </Reveal>
        </div>

        <div className="mt-12 divide-y divide-white/8 border-y border-white/8">
          {FAQS.map((f, i) => {
            const isOpen = open === i;
            return (
              <div key={f.q}>
                <button
                  onClick={() => setOpen(isOpen ? null : i)}
                  className="flex w-full items-center justify-between gap-4 py-5 text-left"
                  aria-expanded={isOpen}
                >
                  <span
                    className={cn(
                      "text-[16px] font-medium transition-colors",
                      isOpen ? "text-white" : "text-white/75",
                    )}
                  >
                    {f.q}
                  </span>
                  <span
                    className={cn(
                      "grid size-7 shrink-0 place-items-center rounded-full border border-white/12 text-white/60 transition-transform duration-300",
                      isOpen && "rotate-45 border-emerald-400/30 text-emerald-300",
                    )}
                  >
                    <PlusIcon className="size-4" />
                  </span>
                </button>
                <AnimatePresence initial={false}>
                  {isOpen && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                      className="overflow-hidden"
                    >
                      <p className="pb-6 pr-10 text-[15px] leading-relaxed text-white/55">
                        {f.a}
                      </p>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
