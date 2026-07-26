"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { PlusIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Reveal, Eyebrow } from "@/components/marketing/home/primitives";

/**
 * Beta-focused FAQ. Same accordion mechanics and dark styling as the homepage
 * FAQ, but the questions are the ones a prospect actually has about a free
 * private beta: is it really free, who can join, do I have to migrate
 * everything, can I use real data, will it stay free, can I get my data out.
 */
const FAQS: { q: string; a: ReactNode }[] = [
  {
    q: "Is the beta really free?",
    a: "Yes. TraceTxn is free while we're in private beta. No credit card is required.",
  },
  {
    q: "Who can join?",
    a: "We're currently building TraceTxn for freelancers and agencies that manage ongoing client work.",
  },
  {
    q: "Do I need to move all my clients?",
    a: "No. Start with a few clients and see if TraceTxn fits the way you work.",
  },
  {
    q: "Can I use real client data?",
    a: (
      <>
        Yes, but only include client information you have the right to store and
        manage. Check our{" "}
        <Link
          href="/privacy"
          className="text-emerald-300 underline-offset-4 hover:underline"
        >
          Privacy Policy
        </Link>{" "}
        and{" "}
        <Link
          href="/security"
          className="text-emerald-300 underline-offset-4 hover:underline"
        >
          Security
        </Link>{" "}
        page for more details.
      </>
    ),
  },
  {
    q: "Will TraceTxn always be free?",
    a: "No. We plan to introduce paid plans after the beta. We'll let beta users know before pricing changes.",
  },
  {
    q: "Can I export my data?",
    a: "Yes. Your data is yours, and you can export it from TraceTxn.",
  },
];

export function PricingFaq() {
  const [open, setOpen] = useState<number | null>(0);

  return (
    <section
      id="faq"
      className="relative border-t border-white/8 bg-white/[0.015]"
    >
      <div className="mx-auto max-w-[820px] px-6 py-24 sm:py-28 lg:px-8">
        <div className="text-center">
          <Reveal>
            <Eyebrow className="justify-center">Questions</Eyebrow>
          </Reveal>
          <Reveal delay={0.05}>
            <h2 className="mt-5 font-display text-[32px] font-semibold leading-[1.1] tracking-[-0.025em] text-white sm:text-[40px]">
              Beta questions, answered.
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
