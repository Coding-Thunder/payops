import type { NextRequest } from "next/server";

import { handlePayPalWebhook } from "@/server/api/paypal-webhook";
import { resolveOrganizationId } from "@/server/auth/organization";
import { logger } from "@/lib/logger";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The DEPLOYMENT-LEVEL PayPal webhook endpoint.
 *
 * This is the path the incumbent organization's PayPal account is (or will
 * be) configured against, and it must keep working unchanged — a live
 * merchant's webhook configuration is not something to migrate in order to
 * ship a second tenant.
 *
 * It resolves the deployment's own organization. On a single-organization
 * deployment that is unambiguous. Once a deployment serves several, each
 * ADDITIONAL tenant points its PayPal account at
 * `/api/webhooks/paypal/<slug>` instead, where the tenant is explicit in the
 * URL — see that route for why the tenant cannot be derived from the event.
 *
 * The real logic lives in `handlePayPalWebhook` so both endpoints share one
 * implementation and cannot drift apart.
 */
export async function POST(req: NextRequest) {
  let organizationId: string;
  try {
    organizationId = await resolveOrganizationId();
  } catch (err) {
    logger.error("paypal.webhook.organization_unresolved", {
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "PROVIDER_DISABLED",
          message: "PayPal is not available.",
        },
      },
      { status: 503 },
    );
  }
  // The deployment-level endpoint speaks for the compatibility anchor, so
  // it retains the right to settle unattributed pre-migration orders.
  return handlePayPalWebhook(req, organizationId, true);
}
