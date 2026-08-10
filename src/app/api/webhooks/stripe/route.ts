import type { NextRequest } from "next/server";

import { handleStripeWebhook } from "@/server/api/stripe-webhook";
import { getGateway } from "@/server/payments/gateways";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Deployment-level Stripe webhook endpoint.
 *
 * THE URL AND BEHAVIOUR HERE MUST NOT CHANGE. It is configured in a live
 * Stripe dashboard, and it verifies against STRIPE_WEBHOOK_SECRET exactly
 * as it always has. Organizations that supply their own credentials get
 * their own endpoint at /api/webhooks/stripe/[orgSlug] instead; this one
 * continues to serve the deployment account, which is what the default
 * organization falls back to.
 */
export async function POST(req: NextRequest) {
  return handleStripeWebhook(req, getGateway("STRIPE"));
}
