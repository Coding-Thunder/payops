import { NextResponse, type NextRequest } from "next/server";

import { env } from "@/lib/env";
import { AuditAction, AuditEntity } from "@/lib/constants/enums";
import { logger } from "@/lib/logger";
import { recordAudit } from "@/server/services/audit.service";
import { processStripeEvent } from "@/server/services/webhook.service";
import { getStripe } from "@/server/payments/stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Stripe webhook entry point.
 *
 * Critical rules:
 *  - Always verify the signature; bail out before any DB write if it fails.
 *  - Always return 2xx after a verified event so Stripe doesn't replay it
 *    needlessly, even when we choose not to act on a given event type.
 *  - Idempotency lives in the service layer (processStripeEvent).
 */
export async function POST(req: NextRequest) {
  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json(
      { ok: false, error: { code: "BAD_REQUEST", message: "Missing signature" } },
      { status: 400 },
    );
  }

  const rawBody = await req.text();
  const stripe = getStripe();

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      env.server.STRIPE_WEBHOOK_SECRET,
    );
  } catch (err) {
    logger.warn("stripe.invalid_signature", {
      err: err instanceof Error ? err.message : String(err),
    });
    await recordAudit({
      action: AuditAction.WEBHOOK_FAILED,
      entityType: AuditEntity.WEBHOOK,
      metadata: {
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
    const result = await processStripeEvent(event);
    return NextResponse.json({
      ok: true,
      data: { received: true, ...result },
    });
  } catch (err) {
    logger.error("stripe.processing_failed", {
      eventId: event.id,
      type: event.type,
      err: err instanceof Error ? err.message : String(err),
    });
    await recordAudit({
      action: AuditAction.WEBHOOK_FAILED,
      entityType: AuditEntity.WEBHOOK,
      entityId: event.id,
      metadata: {
        type: event.type,
        err: err instanceof Error ? err.message : String(err),
      },
    });
    // Return 500 so Stripe will retry. The processing is idempotent.
    return NextResponse.json(
      { ok: false, error: { code: "INTERNAL_ERROR", message: "Failed to process event" } },
      { status: 500 },
    );
  }
}
