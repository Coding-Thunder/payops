import type { NextRequest } from "next/server";

import { handleStripeWebhook } from "@/server/api/stripe-webhook";
import { getGateway } from "@/server/payments/gateways";
import {
  getOrganization,
  runWithOrganization,
} from "@/server/auth/organization";

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
 *
 * THIS IS THE DEPLOYMENT-LEVEL ENDPOINT and it belongs to the incumbent
 * organization. Its Stripe dashboard configuration is live, so it keeps this
 * exact path and these exact env credentials. Every ADDITIONAL tenant points
 * its own Stripe account at `/api/webhooks/stripe/<slug>`, where the tenant
 * is explicit in the URL — a signature can only be verified with the secret
 * of the account that produced it, so it cannot be derived from the payload.
 */
export async function POST(req: NextRequest) {
  const org = await getOrganization();
  // Pin the tenant for everything this delivery writes (audit, evidence,
  // outbox). A webhook carries no session, so without this those rows would
  // be attributed to nothing.
  return runWithOrganization(
    { organizationId: org.id, isDefault: org.isDefault },
    () =>
      handleStripeWebhook(
        req,
        getGateway("STRIPE"),
        org.id,
        org.slug,
        org.isDefault,
      ),
  );
}
