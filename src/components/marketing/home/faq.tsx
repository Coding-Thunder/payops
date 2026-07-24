"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { PlusIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Reveal, Eyebrow } from "./primitives";

const FAQS: { q: string; a: string }[] = [
  {
    q: "Is this a CRM?",
    a: "No. A CRM manages a sales pipeline and chases leads. TraceTxn remembers delivery — the record of what actually happened after a client said yes. Plenty of teams keep both, and use TraceTxn as the memory their CRM never had.",
  },
  {
    q: "Does it replace ClickUp, Stripe, or my accounting tool?",
    a: "No, and it doesn’t try to. Keep running projects where you run them and take payments where you take them. TraceTxn is the permanent record everything feeds into, so the history survives in one place instead of scattering across all of them.",
  },
  {
    q: "How does search work?",
    a: "Search a client’s name, company, email, phone number, or an invoice ID. The matching record opens instantly with the full timeline. It’s designed to feel like Spotlight or Raycast — you type, you’re there — not a database query.",
  },
  {
    q: "Can I store contracts and files?",
    a: "Yes. Agreements, proposals, brand packs and any file attach directly to the client and land on their timeline with the date they were shared or signed — so “which version did they sign?” is never a mystery again.",
  },
  {
    q: "How is my data secured?",
    a: "Every record is scoped to your workspace and isolated from other teams. Sensitive credentials are encrypted, and the important actions on a record are written to a tamper-evident audit trail you can review.",
  },
  {
    q: "Can my team collaborate?",
    a: "Yes. Invite your team and everyone sees the same client record. When someone new joins — or takes over an account — the complete history is their handover, no knowledge-transfer meeting required.",
  },
  {
    q: "Can I export my data?",
    a: "Anytime. Export a client’s complete record — timeline, invoices, payments, approvals and files. It’s your data. There’s no lock-in and nothing is held hostage.",
  },
  {
    q: "Who is it for?",
    a: "Agencies and freelancers who juggle multiple clients over months or years — web, brand, SEO, marketing and development teams who lose time and leverage every time context goes missing.",
  },
];

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
