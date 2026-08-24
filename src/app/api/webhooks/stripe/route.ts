import type { NextRequest } from "next/server";

import { handleStripeWebhook } from "@/server/api/stripe-webhook";
import { getGateway } from "@/server/payments/gateways";
import { resolveOrganizationId } from "@/server/auth/organization";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The Stripe webhook endpoint. There is one, and it is Stripe's.
 *
 * THE PROVIDER IS DECIDED BY THE ENDPOINT, NEVER BY CONFIGURATION. This route
 * resolves `getGateway("STRIPE")` explicitly. The per-organization variant
 * this replaces called `getGatewayForOrganization(orgId)` with no provider
 * argument, which returns whichever provider that organization happens to
 * DEFAULT to — fine while every organization had exactly one gateway, and
 * broken the moment a deployment offers two: a real Stripe delivery would be
 * handed the PayPal adapter, fail signature verification, and no order would
 * ever reach PAID.
 *
 * Credentials come from STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET on the
 * deployment. Verification stays Stripe's own local HMAC over
 * `stripe-signature` — see the adapter. It is not, and must not become, a
 * shared "verify a webhook" helper: PayPal authenticates by calling PayPal
 * back, and collapsing the two would weaken both.
 *
 * The organization is resolved server-side and passed through so the settled
 * order is attributed correctly and audit rows name the tenant.
 */
export async function POST(req: NextRequest) {
  const organizationId = await resolveOrganizationId();
  return handleStripeWebhook(req, getGateway("STRIPE"), organizationId);
}
