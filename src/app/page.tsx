import type { Metadata } from "next";

import { BrandCtaStrip } from "@/components/marketing/brand-cta-strip";
import { BrandFooter } from "@/components/marketing/brand-footer";
import { BrandHero } from "@/components/marketing/brand-hero";
import { BrandNav } from "@/components/marketing/brand-nav";
import { DocumentRail } from "@/components/marketing/page-chrome";
import { AudienceRegion } from "@/components/marketing/regions/audience-region";
import { ClosingRegion } from "@/components/marketing/regions/closing-region";
import { ComparisonRegion } from "@/components/marketing/regions/comparison-region";
import { EvidenceRegion } from "@/components/marketing/regions/evidence-region";
import { FeaturesRegion } from "@/components/marketing/regions/features-region";
import { GatewaysRegion } from "@/components/marketing/regions/gateways-region";
import { IntegrityRegion } from "@/components/marketing/regions/integrity-region";
import { LifecycleRegion } from "@/components/marketing/regions/lifecycle-region";
import { SetupRegion } from "@/components/marketing/regions/setup-region";
import { StructuredData } from "@/components/marketing/seo/structured-data";
import { env } from "@/lib/env";

export const metadata: Metadata = {
  title:
    "Payment Operations Platform · Chargeback Evidence · Multi-Gateway Orchestration",
  description:
    "Every transaction traced, every dollar defended. TraceTxn connects order data, customer invoices, and explicit consent to your payment processor, with a hashed evidence chain, dispute-ready exports, and gateway-agnostic orchestration. Built for Shopify, e-commerce, SaaS, agencies, and B2B commerce. Stripe live · Razorpay + Authorize.net next.",
  alternates: { canonical: "/" },
};

/**
 * TraceTxn landing page, brand-v1 visual system.
 *
 *   1. BrandNav     , sticky top, switches to blurred-white chrome
 *                       on scroll
 *   2. BrandHero     , dark hero, "Every transaction traced. Every
 *                       dollar defended." + dual CTA + checklist
 *   3. Rich regions , narrative-ordered product content wrapped by the
 *                       DocumentRail "table of contents":
 *                         How it works  → LifecycleRegion (timeline)
 *                         Who it's for  → AudienceRegion (verticals)
 *                         Features      → FeaturesRegion (capability map)
 *                         Comparison    → ComparisonRegion (vs. baseline)
 *                         Evidence      → EvidenceRegion (case file)
 *                         Security      → IntegrityRegion (compliance)
 *                         Gateways      → GatewaysRegion (payment infra)
 *                         Setup         → SetupRegion (onboarding)
 *   4. ClosingRegion, quotation / sales contact form
 *   5. BrandCtaStrip, Deep Navy conversion panel before the footer
 *   6. BrandFooter   , brand wordmark + 3 link columns + status pill
 *
 * Narrative arc: problem (fragmentation) → solution (one continuous
 * line) → proof (timeline + features + comparison) → trust (evidence +
 * security) → conversion (CTA).
 */
export default function LandingPage() {
  return (
    <div className="bg-background text-foreground">
      <StructuredData />
      <BrandNav />
      <BrandHero />

      {/* Document body, quiet ledger-grid backing behind the
          narrative-ordered rich regions. */}
      <main
        className="relative"
        style={{
          backgroundImage: "var(--doc-grid)",
          backgroundSize: "var(--doc-grid-size)",
        }}
      >
        <div className="mx-auto max-w-[1280px] px-6 lg:px-10">
          <div className="grid grid-cols-1 gap-x-12 lg:grid-cols-[10rem_minmax(0,1fr)] lg:items-start">
            <DocumentRail />
            <div className="min-w-0">
              <LifecycleRegion />
              <AudienceRegion />
              <FeaturesRegion />
              <ComparisonRegion />
              <EvidenceRegion />
              <IntegrityRegion />
              <GatewaysRegion />
              <SetupRegion />
              <ClosingRegion
                turnstileSiteKey={
                  env.public.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? null
                }
              />
            </div>
          </div>
        </div>
      </main>

      <BrandCtaStrip />
      <BrandFooter />
    </div>
  );
}
