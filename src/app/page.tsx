import type { Metadata } from "next";

import { GsapController } from "@/components/marketing/gsap-controller";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { MarketingNav } from "@/components/marketing/marketing-nav";
import { StructuredData } from "@/components/marketing/seo/structured-data";
import { CommerceShapes } from "@/components/marketing/sections/commerce-shapes";
import { EnterpriseChoose } from "@/components/marketing/sections/enterprise-choose";
import { FightDisputes } from "@/components/marketing/sections/fight-disputes";
import { Hero } from "@/components/marketing/sections/hero";
import { Lifecycle } from "@/components/marketing/sections/lifecycle";
import { MultiGateway } from "@/components/marketing/sections/multi-gateway";
import { OrgSetups } from "@/components/marketing/sections/org-setups";
import { QuotationForm } from "@/components/marketing/sections/quotation-form";
import { env } from "@/lib/env";

/**
 * Landing-page metadata. Overrides the root template defaults with
 * a heavier, more keyword-rich description and pinned canonical so
 * `/` is the authoritative URL even if the page is loaded via
 * tracking params (utm_*, ref=, etc.).
 */
export const metadata: Metadata = {
  title:
    "Payment Operations Platform · Chargeback Evidence · Multi-Gateway Orchestration",
  description:
    "Lifecycle visibility from order creation to chargeback. Hashed evidence chain, hosted consent, multi-gateway orchestration. Reserved for one merchant per instance. Stripe live · Razorpay + Authorize.net next.",
  alternates: { canonical: "/" },
};

/**
 * PayOps marketing landing page.
 *
 * Eight chapters, each with its own color theme (CSS variables in
 * `globals.css` driven by `data-theme`):
 *
 *   1. Hero        — obsidian (dark, aurora orbs)
 *   2. Disputes    — orange (sticky scroll, evidence chain)
 *   3. Lifecycle   — sage (React timeline + 12-surface bento)
 *   4. Shapes      — graphite (dark spec-sheet · 8 commerce verticals)
 *   5. Gateways    — cobalt (logo bento + code interface block)
 *   6. Trust       — cream (animated counters + audit pillars)
 *   7. Workflows   — ultraviolet (steps + included list)
 *   8. Closing     — closing/dark (form + email channel)
 *
 * Free scroll only — snap-mandatory removed. The GSAP controller
 * handles reveal + parallax + count-up + theme-aware nav.
 */
export default function LandingPage() {
  return (
    <div>
      {/* Structured data (Organization / WebSite / SoftwareApplication
          / FAQPage) — rendered server-side, picked up by Google +
          Bing for rich-result eligibility (FAQ accordion, sitelinks
          search box, product knowledge panel). */}
      <StructuredData />
      <MarketingNav />
      <GsapController />
      <main>
        <Hero />
        <FightDisputes />
        <Lifecycle />
        <CommerceShapes />
        <MultiGateway />
        <EnterpriseChoose />
        <OrgSetups />
        <QuotationForm
          turnstileSiteKey={env.public.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? null}
        />
      </main>
      <MarketingFooter />
    </div>
  );
}
