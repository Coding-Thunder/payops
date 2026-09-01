import { NextResponse, type NextRequest } from "next/server";

import { RecordState } from "@/lib/constants/enums";
import { logger } from "@/lib/logger";
import { Organization } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import { handlePayPalWebhook } from "@/server/api/paypal-webhook";
import { runWithOrganization } from "@/server/auth/organization";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ orgSlug: string }>;
}

/**
 * Per-organization PayPal webhook endpoint.
 *
 * PayPal does not sign with a shared secret the way Stripe does — the
 * adapter verifies by calling PayPal back at
 * `/v1/notifications/verify-webhook-signature` with the five transmission
 * headers AND the organization's own `webhookId`, authenticated with that
 * organization's client credentials. So the tenant is needed BEFORE the
 * payload can be trusted, for the same reason it is with Stripe, and the
 * only place it can come from is the URL.
 *
 * Verifying an RCR Cruise delivery against Himanshu's webhook id would fail
 * — which is the safe direction — but it would fail forever, leaving a
 * customer charged and their order stuck in PAYMENT_PENDING. That is the
 * failure this route exists to prevent.
 *
 * The DEFAULT organization keeps `/api/webhooks/paypal`, untouched.
 *
 * An unknown or disabled slug returns a flat 404 so the endpoint cannot be
 * used to enumerate which brands live on this deployment. A known-but-
 * unconfigured organization is answered by the shared handler with 503,
 * which is the honest distinction between "no such endpoint" and "this
 * endpoint exists and its credentials are missing".
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { orgSlug } = await params;

  await connectMongo();
  const org = await Organization.findOne({
    slug: orgSlug.toLowerCase(),
    status: RecordState.ACTIVE,
  })
    .select("_id slug isDefault")
    .lean<{ _id: unknown; slug: string; isDefault?: boolean } | null>();

  if (!org) {
    logger.warn("paypal.webhook.unknown_organization", { orgSlug });
    return NextResponse.json(
      { ok: false, error: { code: "NOT_FOUND", message: "Unknown endpoint" } },
      { status: 404 },
    );
  }

  const organizationId = String(org._id);
  const isDefault = Boolean(org.isDefault);

  // Pin the tenant so audit, evidence and outbox rows written while
  // settling this delivery are attributed to the right brand.
  return runWithOrganization({ organizationId, isDefault }, () =>
    handlePayPalWebhook(req, organizationId, isDefault),
  );
}
