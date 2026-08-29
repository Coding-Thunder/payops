import { notFound } from "next/navigation";

import { PublicBrandChrome } from "@/components/public/public-brand-chrome";
import { resolvePublicBrand } from "@/server/email/identity";
import { getBranding } from "@/server/services/branding.service";
import { getPublicConsentView } from "@/server/services/consent.service";
import { AppError } from "@/lib/errors";

import { ConsentForm } from "./consent-form";

export const dynamic = "force-dynamic";

interface ConsentPageProps {
  params: Promise<{ token: string }>;
}

/**
 * PER-BRAND TAB TITLE.
 *
 * The root layout sets `title.template = "%s • <deployment name>"`, so a
 * plain string title here would render as "Confirm your booking • PayOps"
 * (or "• Rental Confirmation") in a FlightBizz customer's browser tab and
 * in anything that scrapes the page. `title.absolute` opts out of the
 * parent template entirely.
 *
 * The default organization resolves to the deployment brand name, so the
 * incumbent's tab reads exactly what it read before.
 */
export async function generateMetadata({ params }: ConsentPageProps) {
  const { token } = await params;
  const branding = await getBranding();
  try {
    const view = await getPublicConsentView(token, branding);
    const brand = await resolvePublicBrand(view.organizationId, branding);
    return { title: { absolute: `Confirm your booking • ${brand.brandName}` } };
  } catch {
    // An expired or unknown token must not leak which brands exist here.
    return { title: { absolute: "Confirm your booking" } };
  }
}

/**
 * Public hosted consent page. Customer arrives here from the "I Agree"
 * button in the payment-request email. Renders an order summary + a
 * single-button confirm form. On submit the form hits POST
 * /api/consent/[token]; on success we swap into a "thanks" state that
 * deep-links to the payment page.
 */
export default async function ConsentPage({ params }: ConsentPageProps) {
  const { token } = await params;
  const branding = await getBranding();

  let view;
  try {
    view = await getPublicConsentView(token, branding);
  } catch (err) {
    if (err instanceof AppError && (err.statusCode === 400 || err.statusCode === 404)) {
      notFound();
    }
    throw err;
  }

  // Brand the chrome and the form's support links to the booking's
  // organization. `branding` remains the fallback the default organization
  // resolves to, so nothing about the incumbent brand's page changes.
  const brand = await resolvePublicBrand(view.organizationId, branding);
  const brandedForForm = {
    ...branding,
    brandName: brand.brandName,
    supportEmail: brand.supportEmail,
    supportPhone: brand.supportPhone,
    logo: brand.logo,
    primaryColor: brand.primaryColor,
    footerTagline: brand.footerTagline,
  };

  return (
    <PublicBrandChrome brand={brand} eyebrow="Secure confirmation">
      <ConsentForm
        token={token}
        initialView={view}
        branding={brandedForForm}
      />
    </PublicBrandChrome>
  );
}
