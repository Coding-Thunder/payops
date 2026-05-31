import Link from "next/link";
import { ArrowRightIcon, CheckCircle2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Brand-v1 hero — layered dark composition over an Unsplash analytics
 * photo, lifted from the earlier CoverBand treatment.
 *
 * Layer stack:
 *   -z-20  Unsplash analytics-dashboard photo (filter darkens it so it
 *          sits BEHIND the type rather than competing with it).
 *   -z-10  Dark navy gradient — pins the headline area dark for
 *          contrast, lightens toward the right where the emerald wash
 *          sits.
 *    -z-0  Emerald radial wash — single accent, brand-aligned.
 *
 * Single column (no right-side diagram). All copy is white / slate
 * over the dark cover; the chip + CTAs are inverted to match.
 */
export function BrandHero() {
  return (
    <section
      className="relative isolate overflow-hidden border-b border-border"
      style={{ background: "var(--ink-navy)" }}
    >
      {/* Photo layer — operational, not promotional. To swap: change URL. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-20 bg-cover bg-center"
        style={{
          backgroundImage:
            "url(https://images.unsplash.com/photo-1551288049-bebda4e38f71?auto=format&fit=crop&w=1920&q=80)",
          filter: "brightness(0.42) saturate(0.9)",
        }}
      />
      {/* Dark gradient overlay — keeps the headline area highest-contrast. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          background:
            "linear-gradient(110deg, color-mix(in oklch, var(--ink-navy) 92%, transparent) 0%, color-mix(in oklch, var(--ink-navy) 72%, transparent) 55%, color-mix(in oklch, var(--ink-navy) 55%, transparent) 100%)",
        }}
      />
      {/* Emerald radial wash — single brand accent. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-0"
        style={{
          background:
            "radial-gradient(ellipse 55% 55% at 88% 28%, color-mix(in oklch, var(--success) 20%, transparent) 0%, transparent 70%)",
        }}
      />

      <div className="mx-auto max-w-[1280px] px-6 pt-24 pb-28 text-white sm:px-10 sm:pt-28 sm:pb-32">
        <div className="max-w-3xl">
          <p className="inline-flex items-center gap-1.5 rounded-full border border-white/20 bg-white/5 px-3 py-1 font-display text-[10.5px] font-medium uppercase tracking-[0.16em] text-white/85 backdrop-blur-sm">
            <span
              aria-hidden
              className="size-1.5 rounded-full"
              style={{ background: "var(--brand-emerald)" }}
            />
            The operating system for payment ops
          </p>

          <h1 className="mt-7 font-display text-[clamp(2.4rem,6.5vw,4.6rem)] font-medium leading-[1.05] tracking-[-0.025em] text-white">
            Track every transaction.{" "}
            <span className="block font-semibold text-[color:var(--brand-emerald)]">
              Evidence built automatically.
            </span>
          </h1>

          <p className="mt-6 max-w-xl text-[15px] leading-relaxed text-white/75">
            TraceTxn is the operational console between you and your payment
            processor. Lifecycle visibility on every order, a hashed
            evidence chain on every transition, hosted consent before the
            charge — so chargebacks resolve in your favour and your team
            spends time on growth, not paperwork.
          </p>

          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Button asChild size="lg" className="gap-1.5">
              <Link href="/signup">
                Start your workspace
                <ArrowRightIcon className="size-4" />
              </Link>
            </Button>
            <Button
              asChild
              size="lg"
              variant="outline"
              className="border-white/30 bg-white/5 text-white backdrop-blur-sm hover:bg-white/10 hover:text-white"
            >
              <Link href="#evidence">See evidence flow</Link>
            </Button>
          </div>

          <ul className="mt-10 grid grid-cols-1 gap-y-2 text-[12.5px] text-white/75 sm:grid-cols-2 sm:gap-x-6">
            {[
              "Hashed evidence chain per order",
              "Per-org Stripe routing — your keys, encrypted",
              "Tenant-configurable order workflows",
              "Hosted consent + dispute-ready receipts",
            ].map((line) => (
              <li key={line} className="flex items-start gap-2">
                <CheckCircle2Icon
                  className="mt-[2px] size-3.5 shrink-0"
                  style={{ color: "var(--brand-emerald)" }}
                />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
