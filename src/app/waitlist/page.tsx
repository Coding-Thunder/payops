import type { Metadata } from "next";

import { BrandFooter } from "@/components/marketing/brand-footer";
import { BrandNav } from "@/components/marketing/brand-nav";
import { WaitlistForm } from "@/components/marketing/waitlist-form";
import { env } from "@/lib/env";

export const metadata: Metadata = {
  title: "Waitlist — Get an early invite",
  description:
    "Join the TraceTxn waitlist. Early invites unlock the Growth tier free for the first three months and direct access to the founders during onboarding.",
  alternates: { canonical: "/waitlist" },
};

/**
 * Public waitlist. Single screen, brand-v1 chrome, minimal form
 * (name + email + what-you-build). Submission lands in the same
 * `quotations` collection as the landing-page form, tagged
 * `source: "waitlist"` so sales can triage separately.
 *
 * No incentives copy beyond what we can actually deliver — three
 * months of Growth-tier credit + a 15-minute call. If we change
 * that offer, update the copy in BOTH places (hero + the trust
 * strip below).
 */
export default function WaitlistPage() {
  return (
    <div className="bg-background text-foreground">
      <BrandNav />

      <section className="relative overflow-hidden border-b border-border bg-[color:var(--background)]">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10"
          style={{
            background:
              "linear-gradient(180deg, #F8FAFC 0%, #FFFFFF 100%)",
          }}
        />

        <div className="mx-auto grid max-w-[1280px] grid-cols-1 gap-y-12 px-6 pt-20 pb-24 sm:px-10 sm:pt-24 lg:grid-cols-[1.1fr_1fr] lg:items-center lg:gap-x-16">
          {/* Left — copy */}
          <div className="max-w-xl">
            <p className="inline-flex items-center gap-1.5 rounded-full border border-border bg-white px-3 py-1 font-display text-[10.5px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
              <span
                aria-hidden
                className="size-1.5 rounded-full"
                style={{ background: "var(--brand-emerald)" }}
              />
              Waitlist
            </p>

            <h1 className="mt-7 font-display text-[clamp(2rem,5vw,3.6rem)] font-medium leading-[1.05] tracking-[-0.025em]">
              Get an early invite.{" "}
              <span className="block font-semibold text-[color:var(--brand-emerald)]">
                Three months on us.
              </span>
            </h1>

            <p className="mt-6 max-w-lg text-[15px] leading-relaxed text-muted-foreground">
              We&apos;re rolling out access in small batches so we can
              hand-hold every early tenant through onboarding. Drop your
              email — when your batch opens, you&apos;ll get an invite
              link, three months of Growth-tier credit, and a 15-minute
              call with the founders if you want one.
            </p>

            <ul className="mt-9 grid grid-cols-1 gap-y-3 text-[13px] text-muted-foreground sm:grid-cols-2">
              {[
                "First-batch invites unlock Growth ($99/mo) free for 3 months",
                "Optional 15-min founder call during your onboarding",
                "Direct line to bug fixes + feature requests",
                "No card required to start the trial",
              ].map((line) => (
                <li key={line} className="flex items-start gap-2">
                  <span
                    aria-hidden
                    className="mt-1.5 size-1.5 shrink-0 rounded-full"
                    style={{ background: "var(--brand-emerald)" }}
                  />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Right — form card */}
          <div>
            <WaitlistForm
              turnstileSiteKey={
                env.public.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? null
              }
            />
          </div>
        </div>
      </section>

      <BrandFooter />
    </div>
  );
}
