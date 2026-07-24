"use client";

import Link from "next/link";
import { motion } from "motion/react";
import { ArrowRightIcon } from "lucide-react";

import { HeroPreview } from "./hero-preview";

const EASE = [0.22, 1, 0.36, 1] as const;

/**
 * Hero. Story-first: the headline states the promise, the preview
 * proves it. No dashboard screenshot — the visitor watches an agency
 * search a client and get the whole relationship back.
 */
export function Hero() {
  return (
    <div className="relative overflow-hidden">
      {/* faint dotted grid + top glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          backgroundImage:
            "radial-gradient(circle at 1px 1px, rgba(255,255,255,0.05) 1px, transparent 0)",
          backgroundSize: "38px 38px",
          maskImage:
            "radial-gradient(80% 60% at 50% 0%, black, transparent 75%)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[520px]"
        style={{
          background:
            "radial-gradient(50% 60% at 50% -10%, rgba(52,211,153,0.10), transparent 70%)",
        }}
      />

      <div className="mx-auto grid max-w-[1140px] items-center gap-14 px-6 pb-20 pt-16 sm:pt-20 lg:grid-cols-[1fr_1.02fr] lg:gap-10 lg:px-8 lg:pb-28 lg:pt-24">
        {/* left: message */}
        <div className="max-w-xl">
          <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: EASE }}
            className="inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/[0.04] px-3 py-1.5 text-[12px] text-white/60"
          >
            <span className="size-1.5 rounded-full bg-emerald-400" />
            Private beta · built for agencies &amp; freelancers
          </motion.div>

          <motion.h1
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.06, ease: EASE }}
            className="mt-6 font-display text-[42px] font-semibold leading-[1.04] tracking-[-0.03em] text-white sm:text-[54px] lg:text-[58px]"
          >
            One permanent record
            <br />
            for every client.
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.14, ease: EASE }}
            className="mt-6 text-[16.5px] leading-relaxed text-white/60"
          >
            Invoices, payments, approvals, files, and the entire history of the
            relationship — in one searchable place. So when a client resurfaces
            six months later, you already have the answer.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.22, ease: EASE }}
            className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center"
          >
            <Link
              href="/signup"
              className="group inline-flex h-11 items-center justify-center gap-1.5 rounded-xl bg-white px-5 text-[14px] font-semibold text-[#08090b] transition-transform duration-150 hover:bg-white/90 active:translate-y-px"
            >
              Join the beta
              <ArrowRightIcon className="size-4 transition-transform duration-200 group-hover:translate-x-0.5" />
            </Link>
            <a
              href="#demo"
              className="inline-flex h-11 items-center justify-center rounded-xl border border-white/14 bg-white/[0.02] px-5 text-[14px] font-medium text-white/80 transition-colors hover:border-white/25 hover:text-white"
            >
              See how it works
            </a>
          </motion.div>

          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.6, delay: 0.32 }}
            className="mt-6 text-[13px] text-white/35"
          >
            No card required · Import your existing clients · Export anytime
          </motion.p>
        </div>

        {/* right: the proof */}
        <motion.div
          initial={{ opacity: 0, y: 24, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.7, delay: 0.2, ease: EASE }}
        >
          <HeroPreview />
        </motion.div>
      </div>
    </div>
  );
}
