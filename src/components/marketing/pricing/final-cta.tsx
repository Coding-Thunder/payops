"use client";

import Link from "next/link";
import { ArrowRightIcon } from "lucide-react";

import { Reveal } from "@/components/marketing/home/primitives";

/**
 * Closing panel for the pricing page. Restates the whole product in one line
 * and points at the single action — join the beta. Same dark card, radial
 * glow and dotted mask as the homepage final CTA so the two pages read as one
 * surface.
 */
export function PricingFinalCta() {
  return (
    <section className="relative border-t border-white/8">
      <div className="mx-auto max-w-[1140px] px-6 py-24 sm:py-28 lg:px-8">
        <Reveal>
          <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-[#0b0d10] px-6 py-16 text-center sm:px-10 sm:py-20">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0"
              style={{
                background:
                  "radial-gradient(60% 80% at 50% 0%, rgba(52,211,153,0.14), transparent 70%)",
              }}
            />
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 opacity-40"
              style={{
                backgroundImage:
                  "radial-gradient(circle at 1px 1px, rgba(255,255,255,0.05) 1px, transparent 0)",
                backgroundSize: "34px 34px",
                maskImage:
                  "radial-gradient(70% 60% at 50% 40%, black, transparent 80%)",
              }}
            />

            <div className="relative">
              <h2 className="mx-auto max-w-2xl font-display text-[34px] font-semibold leading-[1.08] tracking-[-0.028em] text-white sm:text-[48px]">
                Give every client one searchable record.
              </h2>
              <p className="mx-auto mt-5 max-w-xl text-[16.5px] leading-relaxed text-white/60">
                Join the private beta and start with the clients you already
                have.
              </p>

              <div className="mt-9 flex items-center justify-center">
                <Link
                  href="/signup"
                  className="group inline-flex h-11 items-center justify-center gap-1.5 rounded-xl bg-white px-6 text-[14px] font-semibold text-[#08090b] transition-transform duration-150 hover:bg-white/90 active:translate-y-px"
                >
                  Join the beta
                  <ArrowRightIcon className="size-4 transition-transform duration-200 group-hover:translate-x-0.5" />
                </Link>
              </div>

              <p className="mt-6 text-[13px] text-white/35">
                Free during beta. No credit card required.
              </p>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
