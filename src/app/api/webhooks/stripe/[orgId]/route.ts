import { NextResponse, type NextRequest } from "next/server";
import { Types } from "mongoose";

import { AuditAction, AuditEntity, PaymentGatewayKey } from "@/lib/constants/enums";
import { logger } from "@/lib/logger";
import { getGatewayForOrg } from "@/server/payments/gateways";
import { recordAudit } from "@/server/services/audit.service";
import { kickPostCommitDrain } from "@/server/services/email-outbox.service";
import { processGatewayEvent } from "@/server/services/webhook.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Per-org Stripe webhook entry point.
 *
 * URL: `/api/webhooks/stripe/[orgId]`
 *
 * Tenant onboarding flow:
 *   1. Operator pastes their Stripe secret + webhook signing secret
 *      into /admin/gateways → row persisted in `gateway_credentials`.
 *   2. Operator copies THIS URL (with their orgId baked in) into the
 *      "Endpoint URL" field on Stripe's dashboard.
 *   3. Future events fan in here. We resolve the per-org credentials,
 *      verify the signature against THEIR webhook secret, and process
 *      with `scope: { orgId }` so the order-lookup pins to their tenant.
 *
 * Why a separate route and not "global URL + lookup by Stripe account":
 *   - Stripe Connect's `account` field on events only populates for
 *     marketplace mode. Direct merchant accounts (which is the model
 *     TraceTxn's tenants use) don't carry it.
 *   - Routing in the URL is the simplest, most-auditable design: the
 *     URL itself encodes which tenant should verify the signature.
 *
 * Legacy `/api/webhooks/stripe` (without `[orgId]`) continues to verify
 * against `env.STRIPE_WEBHOOK_SECRET` and process WITHOUT a scope —
 * Tenant #1's existing setup keeps working unchanged.
 */

const MAX_WEBHOOK_BODY = 64 * 1024;

interface RouteParams {
  params: Promise<{ orgId: string }>;
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  const { orgId } = await params;
  if (!Types.ObjectId.isValid(orgId)) {
    return NextResponse.json(
      {
        ok: false,
        error: { code: "BAD_REQUEST", message: "Invalid orgId" },
      },
      { status: 400 },
    );
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json(
      {
        ok: false,
        error: { code: "BAD_REQUEST", message: "Missing signature" },
      },
      { status: 400 },
    );
  }

  const declaredLen = req.headers.get("content-length");
  if (declaredLen) {
    const n = Number.parseInt(declaredLen, 10);
    if (Number.isFinite(n) && n > MAX_WEBHOOK_BODY) {
      return NextResponse.json(
        {
          ok: false,
          error: { code: "BAD_REQUEST", message: "Body too large" },
        },
        { status: 413 },
      );
    }
  }

  const rawBody = await req.text();
  if (rawBody.length > MAX_WEBHOOK_BODY) {
    return NextResponse.json(
      {
        ok: false,
        error: { code: "BAD_REQUEST", message: "Body too large" },
      },
      { status: 413 },
    );
  }

  // Resolve the per-org Stripe gateway — pulls credentials from the
  // `gateway_credentials` collection and builds a Stripe client bound
  // to that secret. Returns null when the org never configured Stripe
  // or disabled it.
  const gateway = await getGatewayForOrg(orgId, PaymentGatewayKey.STRIPE);
  if (!gateway) {
    logger.warn("stripe.per_org_webhook.no_credentials", { orgId });
    // Return 404 (not 400) so a misconfigured tenant doesn't tempt
    // Stripe into burning through its retry budget. Once they fix
    // their config, replay-from-dashboard recovers history.
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: "No Stripe credentials configured for this organization",
        },
      },
      { status: 404 },
    );
  }

  let event;
  try {
    event = gateway.verifyWebhook(rawBody, signature);
  } catch (err) {
    logger.warn("stripe.per_org_webhook.invalid_signature", {
      orgId,
      err: err instanceof Error ? err.message : String(err),
    });
    await recordAudit({
      action: AuditAction.WEBHOOK_FAILED,
      entityType: AuditEntity.WEBHOOK,
      orgId,
      metadata: {
        gateway: gateway.key,
        reason: "invalid_signature",
        err: err instanceof Error ? err.message : String(err),
      },
    });
    return NextResponse.json(
      {
        ok: false,
        error: { code: "BAD_REQUEST", message: "Invalid signature" },
      },
      { status: 400 },
    );
  }

  try {
    // The orgId scope pins every order lookup inside the handler to
    // this tenant — a stale event id, paymentIntentId, or sessionId
    // from another tenant can never resolve the wrong order, even on
    // the cosmic-bad-luck case where one of those identifiers
    // collides.
    const result = await processGatewayEvent(event, { orgId });
    kickPostCommitDrain();
    return NextResponse.json({
      ok: true,
      data: { received: true, ...result },
    });
  } catch (err) {
    logger.error("stripe.per_org_webhook.processing_failed", {
      orgId,
      eventId: event.eventId,
      type: event.type,
      err: err instanceof Error ? err.message : String(err),
    });
    await recordAudit({
      action: AuditAction.WEBHOOK_FAILED,
      entityType: AuditEntity.WEBHOOK,
      entityId: event.eventId,
      orgId,
      metadata: {
        gateway: gateway.key,
        type: event.type,
        err: err instanceof Error ? err.message : String(err),
      },
    });
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "Failed to process event",
        },
      },
      { status: 500 },
    );
  }
}
