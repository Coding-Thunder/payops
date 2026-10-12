import Link from "next/link";

import { Button } from "@/components/ui/button";

/**
 * Brand-v1 CTA strip, the conversion moment between the rich
 * content regions and the footer. Deep Navy panel on Cloud, single
 * emerald accent on the eyebrow. Reads as a calm "ready when you
 * are" statement, not a marketing scream.
 */
export function BrandCtaStrip() {
  return (
    <section className="border-y border-border bg-[color:var(--background)] py-20">
      <div className="mx-auto max-w-[1280px] px-6 lg:px-10">
        <div
          className="relative overflow-hidden rounded-2xl p-10 sm:p-14"
          style={{ background: "var(--ink-navy)" }}
        >
          {/* Quiet emerald wash in the corner, same vocabulary as
              the wordmark accent, no decorative gradients. */}
          <div
            aria-hidden
            className="pointer-events-none absolute -right-20 -top-20 size-72 rounded-full opacity-50"
            style={{
              background:
                "radial-gradient(closest-side, color-mix(in oklch, var(--brand-emerald) 32%, transparent), transparent)",
            }}
          />
          <div className="relative grid grid-cols-1 items-center gap-8 lg:grid-cols-[1.4fr_1fr]">
            <div>
              <p
                className="font-display text-[10.5px] font-semibold uppercase tracking-[0.18em]"
                style={{ color: "var(--brand-emerald)" }}
              >
                Built for agencies &amp; freelancers
              </p>
              <h2 className="mt-3 font-display text-[clamp(1.6rem,3.2vw,2.4rem)] font-medium leading-[1.15] tracking-[-0.015em] text-white">
                Stop reconstructing{" "}
                <span className="font-semibold">client history.</span>
              </h2>
              <p className="mt-4 max-w-xl text-[14px] leading-relaxed text-white/72">
                Give every client one permanent, searchable record.
              </p>
            </div>

            <div className="flex flex-col items-start gap-3 lg:items-end">
              <Button
                asChild
                size="lg"
                className="bg-white text-foreground hover:bg-white/90"
              >
                <Link href="/login">Sign in</Link>
              </Button>
              <p className="text-[12.5px] text-white/60">
                In private beta and currently invite-only.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
