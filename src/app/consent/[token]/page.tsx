import { notFound } from "next/navigation";

import { getBranding } from "@/server/services/branding.service";
import { getPublicConsentView } from "@/server/services/consent.service";
import { AppError } from "@/lib/errors";

import { ConsentForm } from "./consent-form";

export const dynamic = "force-dynamic";

interface ConsentPageProps {
  params: Promise<{ token: string }>;
}

/**
 * Public hosted consent page. Customer arrives here from the "I Agree"
 * button in the payment-request email. Renders an order summary + a
 * single-button confirm form. On submit the form hits POST
 * /api/consent/[token]; on success we swap into a "thanks" state that
 * deep-links to the Stripe payment page.
 */
export default async function ConsentPage({ params }: ConsentPageProps) {
  const { token } = await params;
  const branding = await getBranding();

  let view;
  try {
    view = await getPublicConsentView(token, {
      brandName: branding.brandName,
    });
  } catch (err) {
    if (err instanceof AppError && (err.statusCode === 400 || err.statusCode === 404)) {
      notFound();
    }
    throw err;
  }

  return <ConsentForm token={token} initialView={view} branding={branding} />;
}
