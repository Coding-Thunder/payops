import type { Metadata } from "next";

import { BrokenWorkflow } from "@/components/marketing/home/broken-workflow";
import { Comparison } from "@/components/marketing/home/comparison";
import { Faq } from "@/components/marketing/home/faq";
import { Features } from "@/components/marketing/home/features";
import { FinalCta } from "@/components/marketing/home/final-cta";
import { Hero } from "@/components/marketing/home/hero";
import { Problem } from "@/components/marketing/home/problem";
import { ProductDemo } from "@/components/marketing/home/product-demo";
import { SiteFooter } from "@/components/marketing/home/site-footer";
import { SiteHeader } from "@/components/marketing/home/site-header";
import { Solution } from "@/components/marketing/home/solution";
import { UseCases } from "@/components/marketing/home/use-cases";
import { StructuredData } from "@/components/marketing/seo/structured-data";

export const metadata: Metadata = {
  title:
    "TraceTxn — One permanent record for every client",
  description:
    "TraceTxn gives agencies and freelancers one permanent, searchable record per client: invoices, payments, approvals, files, and the full timeline of the relationship. Stop reconstructing what happened across Gmail, Drive, Slack, and Stripe.",
  alternates: { canonical: "/" },
};

/**
 * Homepage — story-first redesign.
 *
 * The whole page commits to one wedge: agencies lose context, and lost
 * context is expensive. The narrative walks a visitor from their own
 * pain to the fix, showing rather than listing:
 *
 *   Hero            → search a client, get their whole history (live preview)
 *   Problem         → the "6 months later" message every agency has had
 *   BrokenWorkflow  → why 8 tools can't answer one question
 *   Solution        → one permanent, searchable record
 *   ProductDemo     → open the record, see every angle (interactive)
 *   Features        → outcomes, not a spec sheet
 *   UseCases        → recognise your exact situation
 *   Comparison      → same question, two very different afternoons
 *   Faq             → the honest objections
 *   FinalCta        → join the beta
 *
 * Dark, black-and-white with a single emerald accent. All motion is
 * reveal-on-scroll or self-driving preview loops — nothing decorative.
 */
export default function LandingPage() {
  return (
    <div className="min-h-screen bg-[#08090b] text-white antialiased">
      <StructuredData />
      <SiteHeader />
      <main>
        <Hero />
        <Problem />
        <BrokenWorkflow />
        <Solution />
        <ProductDemo />
        <Features />
        <UseCases />
        <Comparison />
        <Faq />
        <FinalCta />
      </main>
      <SiteFooter />
    </div>
  );
}
