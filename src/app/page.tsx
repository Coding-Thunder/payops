import type { Metadata } from "next";

import { CoverBand } from "@/components/marketing/cover-band";
import { DocumentFooter } from "@/components/marketing/document-footer";
import {
  DocumentRail,
  TopBand,
} from "@/components/marketing/page-chrome";
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
 * TraceTxn landing page — composed as one continuous document, not
 * a stack of marketing sections.
 *
 * Structure:
 *   - TopBand (sticky utility chrome)
 *   - CoverBand (full-width dark cover, the document opening)
 *   - DocumentRail (sticky left anchor list — table of contents)
 *   - Document body composed of regions, each with its own
 *     composition (different column ratios, different densities)
 *   - DocumentFooter (closing strip)
 *
 * No MarketingSection wrappers, no per-region eyebrow/title chrome,
 * no per-section theme washes. Regions vary visually because they're
 * purpose-built for their content, not because they share a section
 * grammar with different styling.
 */
export default function LandingPage() {
  return (
    <div className="bg-background text-foreground">
      <StructuredData />
      <TopBand />
      <CoverBand />

      <main className="mx-auto max-w-[1280px] px-6 lg:px-10">
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
      </main>

      <DocumentFooter />
    </div>
  );
}
