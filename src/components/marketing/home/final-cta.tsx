"use client";

import Link from "next/link";
import { ArrowRightIcon } from "lucide-react";

import { Reveal } from "./primitives";

/**
 * Closing conversion panel. One promise, one primary action. The line
 * restates the whole page in seven words.
 */
export function FinalCta() {
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
                Never reconstruct a client&apos;s history again.
              </h2>
              <p className="mx-auto mt-5 max-w-xl text-[16.5px] leading-relaxed text-white/60">
                Join the beta and give every client one permanent record —
                starting with the ones you already have.
              </p>

              <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
                <Link
                  href="/signup"
                  className="group inline-flex h-11 items-center justify-center gap-1.5 rounded-xl bg-white px-6 text-[14px] font-semibold text-[#08090b] transition-transform duration-150 hover:bg-white/90 active:translate-y-px"
                >
                  Join the beta
                  <ArrowRightIcon className="size-4 transition-transform duration-200 group-hover:translate-x-0.5" />
                </Link>
                <Link
                  href="/contact"
                  className="inline-flex h-11 items-center justify-center rounded-xl border border-white/14 bg-white/[0.02] px-6 text-[14px] font-medium text-white/80 transition-colors hover:border-white/25 hover:text-white"
                >
                  Talk to us
                </Link>
              </div>

              <p className="mt-6 text-[13px] text-white/35">
                Free during beta · Import your clients in minutes · Export anytime
              </p>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
