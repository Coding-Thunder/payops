"use client";

import Link from "next/link";
import { motion } from "motion/react";
import { ArrowRightIcon } from "lucide-react";

const EASE = [0.22, 1, 0.36, 1] as const;

/**
 * Pricing hero. Light ground, matching the homepage and the rest of the
 * site, tuned to a single centred column. Three things land in the first
 * screen: it's a private beta, it's free, and it's for agencies and
 * freelancers.
 */
export function PricingHero() {
  return (
    <section className="relative overflow-hidden">
      {/* faint dotted grid — same vocabulary as the homepage hero */}
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

      <div className="mx-auto max-w-[760px] px-6 pb-14 pt-20 text-center sm:pt-24 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: EASE }}
          className="inline-flex items-center gap-2 rounded-full border border-[#E2E8F0] bg-white px-3 py-1.5 text-[12px] font-medium uppercase tracking-[0.14em] text-[#4A5568]"
        >
          <span className="relative flex size-1.5">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-[var(--brand-emerald)] opacity-60" />
            <span className="relative inline-flex size-1.5 rounded-full bg-[var(--brand-emerald)]" />
          </span>
          Private beta
        </motion.div>

        <motion.h1
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.06, ease: EASE }}
          className="mt-6 font-display text-[40px] font-semibold leading-[1.05] tracking-[-0.03em] text-[#0A1128] sm:text-[54px]"
        >
          Free while we&apos;re in beta.
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.14, ease: EASE }}
          className="mx-auto mt-6 max-w-xl text-[16.5px] leading-relaxed text-[#4A5568]"
        >
          We&apos;re working with a small group of agencies and freelancers
          while we build TraceTxn. Join the beta, use it with your real clients,
          and help us make it better.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.22, ease: EASE }}
          className="mt-8 flex items-center justify-center"
        >
          <Link
            href="/waitlist"
            className="group inline-flex h-11 items-center justify-center gap-1.5 rounded-xl bg-[#0F172A] px-6 text-[14px] font-semibold text-white transition-colors duration-150 hover:bg-[#1E293B]"
          >
            Join the beta
            <ArrowRightIcon className="size-4 transition-transform duration-200 group-hover:translate-x-0.5" />
          </Link>
        </motion.div>

        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6, delay: 0.32 }}
          className="mt-5 text-[13px] text-[#64748B]"
        >
          No credit card required.
        </motion.p>
      </div>
    </section>
  );
}
