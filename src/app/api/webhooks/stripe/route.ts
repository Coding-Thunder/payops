import { NextResponse, type NextRequest } from "next/server";

import { AuditAction, AuditEntity } from "@/lib/constants/enums";
import { logger } from "@/lib/logger";
import { recordAudit } from "@/server/services/audit.service";
import { kickPostCommitDrain } from "@/server/services/email-outbox.service";
import { processGatewayEvent } from "@/server/services/webhook.service";
import { getGateway } from "@/server/payments/gateways";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Stripe webhook entry point.
 *
 * Pre-flight body cap: 64 KB. Stripe events are typically <20 KB. We
 * check Content-Length and re-check the actual body length after
 * `req.text()` so a missing/lying header can't bypass the cap. Reject
 * before signature verification so an attacker can't burn CPU on
 * gigantic invalid bodies.
 *
 * Critical rules:
 *  - Verify the signature first; bail to 400 before any DB write.
 *  - Always return 2xx after a verified event so the gateway doesn't
 *    replay it needlessly (idempotency is in the service layer via
 *    the durable `ProcessedWebhookEvent` collection).
 *  - Email side-effects DO NOT block the ack, `applyCheckoutPaid`
 *    enqueues to the email outbox inside the transaction, and we
 *    kick a fire-and-forget post-commit drain so the customer sees
 *    confirmation sub-second on the happy path. The 60s in-process
 *    drainer (or a restart) retries any row still PENDING.
 */
const MAX_WEBHOOK_BODY = 64 * 1024;

export async function POST(req: NextRequest) {
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

  const gateway = getGateway("STRIPE");

  let event;
  try {
    event = gateway.verifyWebhook(rawBody, signature);
  } catch (err) {
    logger.warn("stripe.invalid_signature", {
      err: err instanceof Error ? err.message : String(err),
    });
    await recordAudit({
      action: AuditAction.WEBHOOK_FAILED,
      entityType: AuditEntity.WEBHOOK,
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
    const result = await processGatewayEvent(event);
    // Fire-and-forget: if the handler enqueued an email, drain it
    // immediately so the customer gets confirmation sub-second. Skipped
    // in test mode (handled inside `kickPostCommitDrain`).
    kickPostCommitDrain();
    return NextResponse.json({
      ok: true,
      data: { received: true, ...result },
    });
  } catch (err) {
    logger.error("stripe.processing_failed", {
      eventId: event.eventId,
      type: event.type,
      err: err instanceof Error ? err.message : String(err),
    });
    await recordAudit({
      action: AuditAction.WEBHOOK_FAILED,
      entityType: AuditEntity.WEBHOOK,
      entityId: event.eventId,
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
