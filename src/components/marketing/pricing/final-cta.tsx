"use client";


import { Reveal } from "@/components/marketing/home/primitives";

/**
 * Closing panel for the pricing page. Restates the whole product in one line.
 * There is no action on it: the beta is invite-only, so the panel closes the
 * page rather than asking for a sign-up that cannot happen. Same dark card,
 * radial glow and dotted mask as the homepage final CTA so the two pages read
 * as one surface.
 */
export function PricingFinalCta() {
  return (
    <section className="relative border-t border-[#E9EFF6]">
      <div className="mx-auto max-w-[1140px] px-6 py-24 sm:py-28 lg:px-8">
        <Reveal>
          <div className="relative overflow-hidden rounded-3xl bg-[#0A1128] px-6 py-16 text-center sm:px-10 sm:py-20">
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
              <p className="mx-auto mt-5 max-w-xl text-[16.5px] leading-relaxed text-white/70">
                Every order, invoice, payment, file and sent email, kept
                against the client it belongs to.
              </p>

              <p className="mt-8 text-[13px] text-white/50">
                TraceTxn is in private beta and currently invite-only.
              </p>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
