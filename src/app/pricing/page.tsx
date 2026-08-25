import type { Metadata } from "next";

import { SiteFooter } from "@/components/marketing/home/site-footer";
import { SiteHeader } from "@/components/marketing/home/site-header";
import { PricingFaq } from "@/components/marketing/pricing/faq";
import { PricingFinalCta } from "@/components/marketing/pricing/final-cta";
import { PricingHero } from "@/components/marketing/pricing/hero";
import { PricingPlan } from "@/components/marketing/pricing/plan";

import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Pricing",
  description: "TraceTxn is free during private beta \u2014 no card, no tiers. One searchable record per client: orders, invoices, payments and the full relationship timeline.",
  path: "/pricing",
  socialTitle: "Free while we're in private beta \u2022 TraceTxn",
});

/**
 * Pricing — private beta.
 *
 * TraceTxn is in private beta and the beta is free, so this page is not a
 * tier table. It says three things immediately: it's a private beta, it's
 * free, and it's built for agencies and freelancers. One plan card, an honest
 * note about what happens after beta, a short beta FAQ, and one action —
 * join the beta.
 *
 * Shares the redesigned marketing shell (dark ground, single emerald accent,
 * SiteHeader / SiteFooter) with the homepage so the two pages read as one
 * product.
 */
export default function PricingPage() {
  return (
    <div className="min-h-screen bg-[#08090b] text-white antialiased">
      <SiteHeader />
      <main>
        <PricingHero />
        <PricingPlan />
        <PricingFaq />
        <PricingFinalCta />
      </main>
      <SiteFooter />
    </div>
  );
}
