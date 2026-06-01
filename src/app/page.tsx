import type { Metadata } from "next";

import { BrandCtaStrip } from "@/components/marketing/brand-cta-strip";
import { BrandFooter } from "@/components/marketing/brand-footer";
import { BrandHero } from "@/components/marketing/brand-hero";
import { BrandNav } from "@/components/marketing/brand-nav";
import { DocumentRail } from "@/components/marketing/page-chrome";
import { ClosingRegion } from "@/components/marketing/regions/closing-region";
import { EvidenceRegion } from "@/components/marketing/regions/evidence-region";
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
    "Lifecycle visibility from order creation to chargeback. Hashed evidence chain, hosted consent, multi-gateway orchestration. Built for retail, services, repair, dealership, and B2B commerce. Stripe live · Razorpay + Authorize.net next.",
  alternates: { canonical: "/" },
};

/**
 * TraceTxn landing page, brand-v1 visual system.
 *
 *   1. BrandNav     , sticky top, switches to blurred-white chrome
 *                       on scroll
 *   2. BrandHero     , light-mode hero with the four-node trace
 *                       diagram + dual CTA + checklist
 *   3. Rich regions , existing product content (Evidence, Lifecycle,
 *                       Gateways, Integrity, Setup), wrapped by the
 *                       DocumentRail "table of contents"
 *   4. BrandCtaStrip, Deep Navy conversion panel before the footer
 *   5. ClosingRegion, quotation / sales contact form
 *   6. BrandFooter   , brand wordmark + 3 link columns + status pill
 *
 * The rich regions retain their original content + layout, the
 * brand-v1 pass replaces only the chrome (nav, hero, CTA, footer) so
 * the dense product content stays readable while the entry surface
 * matches the spec.
 */
export default function LandingPage() {
  return (
    <div className="bg-background text-foreground">
      <StructuredData />
      <BrandNav />
      <BrandHero />

      {/* Document body, quiet ledger-grid backing behind the
          existing rich regions. */}
      <main
        id="features"
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
              <EvidenceRegion />
              <LifecycleRegion />
              <GatewaysRegion />
              <IntegrityRegion />
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
