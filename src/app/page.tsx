import type { Metadata } from "next";

import { BetaOffer } from "@/components/marketing/home/beta-offer";
import { Comparison } from "@/components/marketing/home/comparison";
import { Faq } from "@/components/marketing/home/faq";
import { FinalCta } from "@/components/marketing/home/final-cta";
import { Hero } from "@/components/marketing/home/hero";
import { Problem } from "@/components/marketing/home/problem";
import { SiteFooter } from "@/components/marketing/home/site-footer";
import { SiteHeader } from "@/components/marketing/home/site-header";
import { Solution } from "@/components/marketing/home/solution";
import { UnifiedWorkspace } from "@/components/marketing/home/unified-workspace";
import { UseCases } from "@/components/marketing/home/use-cases";
import { Walkthrough } from "@/components/marketing/home/walkthrough";
import { StructuredData } from "@/components/marketing/seo/structured-data";

import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Client Management Software for Agencies & Service Businesses | TraceTxn",
  description:
    "Client management software for agencies and service businesses. Keep every client's orders, invoices, payments, files and email in one searchable record.",
  path: "/",
  absoluteTitle: true,
});

/**
 * Homepage — product-led, light fintech.
 *
 * ── The wedge ────────────────────────────────────────────────────────────
 *
 * One idea, carried the whole way down: a client's workflow should not live
 * across five tools. The page states the operational problem before it names
 * a feature, and every capability claim is attached to the screen that
 * performs it.
 *
 *   Hero             → the problem, the fix, and the real client record
 *   Problem          → one client's data split across six systems
 *   Solution         → the same fragments, as one lifecycle
 *   Walkthrough      → six capabilities, each shown before it is explained
 *   UnifiedWorkspace → all of it at once, on one screen
 *   UseCases         → who this fits, and who it does not
 *   Comparison       → where each part of the record lives
 *   BetaOffer        → the real offer: free, by invitation
 *   Faq              → the objections, answered from the code
 *   FinalCta         → join the beta
 *
 * ── Why this page is light ───────────────────────────────────────────────
 *
 * It used to render `bg-[#08090b] text-white` while every other marketing
 * surface — /features, /pricing, /security, the client-management cluster,
 * /blog, /reviews — read from the light `--background: #F8FAFC` tokens. A
 * visitor who clicked any nav link crossed a theme boundary mid-session. The
 * page now sits on the same ground as the rest of the site; the only dark
 * surface left is the closing CTA, where the inversion is the point.
 *
 * ── Claim discipline ─────────────────────────────────────────────────────
 *
 * Every capability shown is reachable by a signed-in user today, and the
 * figures inside the product frames are labelled illustrative in the frames
 * themselves. Two things the brief asked for are deliberately absent, because
 * the code cannot back them: priced subscription tiers (there is no
 * subscription billing — see `beta-offer.tsx`) and a "multi-gateway
 * framework" (`PaymentProcessor` has exactly one member, Stripe).
 * `seo-claims.test.ts` fails the build if the surfaces drift.
 */
export default function LandingPage() {
  return (
    <div className="min-h-screen bg-[#F8FAFC] text-[#0F172A] antialiased">
      <StructuredData />
      <SiteHeader />
      <main>
        <Hero />
        <Problem />
        <Solution />
        <Walkthrough />
        <UnifiedWorkspace />
        <UseCases />
        <Comparison />
        <BetaOffer />
        <Faq />
        <FinalCta />
      </main>
      <SiteFooter />
    </div>
  );
}
