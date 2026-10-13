"use client";

import { motion } from "motion/react";

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
      {/* Left over from the dark design: a white dotted grid at 0.05 alpha
          over #F8FAFC composites to the identical pixel — it rendered
          nothing. Removed rather than re-tinted; the glow below is the one
          decorative layer this section needs. */}
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
          while we build TraceTxn. Access is invite-only while we do, so there
          is nothing to buy and nothing to sign up for.
        </motion.p>

        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6, delay: 0.22 }}
          className="mt-8 text-[13px] text-[#64748B]"
        >
          Already have an invitation? Activate it from the link in your email.
        </motion.p>
      </div>
    </section>
  );
}
