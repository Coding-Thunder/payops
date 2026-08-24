import { NextResponse, type NextRequest } from "next/server";

import { PaymentGatewayKey } from "@/lib/constants/enums";
import { logger } from "@/lib/logger";
import { Organization } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import { getOrganization } from "@/server/auth/organization";
import { enabledProvidersOf } from "@/server/payments/resolve-gateway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The PayPal webhook endpoint — present, and deliberately not operational.
 *
 * PayPal is retained in the architecture as a supported provider but is not
 * enabled on this deployment, so nothing here verifies a signature, settles
 * an order, or writes a record. The route exists for two reasons:
 *
 *   1. So a delivery that reaches this deployment — a stale endpoint left
 *      configured in a PayPal dashboard, a copied environment — fails
 *      visibly and leaves a log line, instead of 404-ing into silence or,
 *      worse, being handled by something that assumes it is trustworthy.
 *   2. So enabling PayPal later is a matter of restoring the handler behind
 *      this guard rather than re-deriving the routing.
 *
 * It returns 503 rather than 404: this is a real endpoint that is
 * temporarily unavailable, and PayPal's own retry semantics treat that
 * correctly. It must NEVER return 200 — an acknowledgement tells PayPal the
 * event was processed and stops the retries, which is exactly how a payment
 * silently goes missing.
 */
export async function POST(_req: NextRequest) {
  let enabled: PaymentGatewayKey[] = [];
  try {
    const organization = await getOrganization();
    await connectMongo();
    const org = await Organization.findById(organization.id)
      .select("payments")
      .lean<{
        payments?: {
          provider?: PaymentGatewayKey;
          enabledProviders?: PaymentGatewayKey[];
        };
      } | null>();
    enabled = enabledProvidersOf(org ?? {});
  } catch {
    // Resolution failed; treat that as "not enabled" rather than guessing.
  }

  logger.warn("paypal.webhook.provider_disabled", {
    enabled,
    note: "PayPal delivery received while PayPal is not an enabled provider",
  });

  return NextResponse.json(
    {
      ok: false,
      error: {
        code: "PROVIDER_DISABLED",
        message: "PayPal is not enabled on this deployment.",
      },
    },
    { status: 503 },
  );
}
