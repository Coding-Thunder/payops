"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { PlusIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { FAQS } from "./faq-content";
import { Eyebrow, Reveal } from "./primitives";

/**
 * FAQ accordion.
 *
 * Reads `FAQS` from `./faq-content`, which is the same array the FAQPage
 * JSON-LD is built from. Google requires every FAQ in structured data to be
 * visible on the page, and keeping two hand-maintained copies is exactly how
 * that requirement breaks quietly — so the content lives in one module and
 * both consumers import it.
 *
 * The first item starts open so the section is not a wall of closed rows in
 * the first frame, and `height: auto` is animated rather than a fixed max so
 * a long answer is never clipped.
 */
export function Faq() {
  const [open, setOpen] = useState<number | null>(0);

  return (
    <section id="faq" className="border-t border-[#E9EFF6] bg-[#F8FAFC]">
      <div className="mx-auto max-w-[840px] px-6 py-20 sm:py-24 lg:px-8">
        <div className="text-center">
          <Reveal>
            <Eyebrow>Questions</Eyebrow>
          </Reveal>
          <Reveal delay={0.05}>
            <h2
              className="mt-4 font-display text-[28px] font-semibold leading-[1.15] tracking-[-0.02em] text-[#0A1128] sm:text-[34px]"
              style={{ textWrap: "balance" }}
            >
              The honest answers.
            </h2>
          </Reveal>
        </div>

        <div className="mt-11 overflow-hidden rounded-lg border border-[#E2E8F0] bg-white">
          <div className="divide-y divide-[#E9EFF6]">
            {FAQS.map((f, i) => {
              const isOpen = open === i;
              return (
                <div key={f.q}>
                  <h3>
                    <button
                      type="button"
                      onClick={() => setOpen(isOpen ? null : i)}
                      aria-expanded={isOpen}
                      className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left transition-colors hover:bg-[#F8FAFC] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--brand-blue)]"
                    >
                      <span
                        className={cn(
                          "text-[14.5px] font-medium leading-snug",
                          isOpen ? "text-[#0A1128]" : "text-[#0F172A]",
                        )}
                      >
                        {f.q}
                      </span>
                      <PlusIcon
                        aria-hidden
                        className={cn(
                          "size-4 shrink-0 text-[#64748B] transition-transform duration-200",
                          isOpen && "rotate-45",
                        )}
                      />
                    </button>
                  </h3>
                  <AnimatePresence initial={false}>
                    {isOpen ? (
                      <motion.div
                        key="body"
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                        className="overflow-hidden"
                      >
                        <p className="max-w-[68ch] px-5 pb-5 text-[13.5px] leading-[1.65] text-[#4A5568]">
                          {f.a}
                        </p>
                      </motion.div>
                    ) : null}
                  </AnimatePresence>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
