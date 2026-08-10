import "server-only";

import { NextResponse, type NextRequest } from "next/server";

import { AuditAction, AuditEntity } from "@/lib/constants/enums";
import { logger } from "@/lib/logger";
import type { PaymentGateway } from "@/server/payments/gateway";
import { recordAudit } from "@/server/services/audit.service";
import { kickPostCommitDrain } from "@/server/services/email-outbox.service";
import { processGatewayEvent } from "@/server/services/webhook.service";

/**
 * Shared Stripe webhook handling, over whichever gateway the caller
 * resolved.
 *
 * Extracted so the deployment endpoint (/api/webhooks/stripe) and the
 * per-organization endpoints (/api/webhooks/stripe/[orgSlug]) are the same
 * code with different credentials, rather than two handlers that drift.
 *
 * Why per-organization endpoints exist at all: a Stripe signature can only
 * be verified with the signing secret of the account that produced it, and
 * the payload cannot be trusted — or even parsed — until that verification
 * succeeds. So there is no way to look at an incoming event and work out
 * which tenant it belongs to. The organization therefore has to be in the
 * URL, which is exactly what Stripe's per-endpoint configuration gives us:
 * each account is pointed at its own path and signs with its own secret.
 *
 * Behaviour is unchanged from the original single-tenant handler:
 *   - 64 KB pre-flight cap, checked on both the header and the real body,
 *     before signature verification, so a bogus giant body cannot burn CPU
 *   - verify first, 400 before any DB write
 *   - always 2xx after a verified event so Stripe stops replaying;
 *     idempotency lives in the durable ProcessedWebhookEvent collection
 *   - email side-effects never block the ack
 */

const MAX_WEBHOOK_BODY = 64 * 1024;

function bad(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function handleStripeWebhook(
  req: NextRequest,
  gateway: PaymentGateway,
  /** Included in audit rows so a failure can be traced to one tenant's
   *  endpoint. Null for the deployment-level endpoint. */
  organizationSlug: string | null = null,
): Promise<NextResponse> {
  const signature = req.headers.get("stripe-signature");
  if (!signature) return bad(400, "BAD_REQUEST", "Missing signature");

  const declaredLen = req.headers.get("content-length");
  if (declaredLen) {
    const n = Number.parseInt(declaredLen, 10);
    if (Number.isFinite(n) && n > MAX_WEBHOOK_BODY) {
      return bad(413, "BAD_REQUEST", "Body too large");
    }
  }

  const rawBody = await req.text();
  if (rawBody.length > MAX_WEBHOOK_BODY) {
    return bad(413, "BAD_REQUEST", "Body too large");
  }

  let event;
  try {
    event = await gateway.verifyWebhook(rawBody, req.headers);
  } catch (err) {
    logger.warn("stripe.invalid_signature", {
      organizationSlug: organizationSlug ?? undefined,
      err: err instanceof Error ? err.message : String(err),
    });
    await recordAudit({
      action: AuditAction.WEBHOOK_FAILED,
      entityType: AuditEntity.WEBHOOK,
      metadata: {
        gateway: gateway.key,
        organizationSlug,
        reason: "invalid_signature",
        err: err instanceof Error ? err.message : String(err),
      },
    });
    return bad(400, "BAD_REQUEST", "Invalid signature");
  }

  try {
    const result = await processGatewayEvent(event);
    kickPostCommitDrain();
    return NextResponse.json({ ok: true, data: { received: true, ...result } });
  } catch (err) {
    logger.error("stripe.processing_failed", {
      organizationSlug: organizationSlug ?? undefined,
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
        organizationSlug,
        type: event.type,
        err: err instanceof Error ? err.message : String(err),
      },
    });
    return bad(500, "INTERNAL_ERROR", "Failed to process event");
  }
}
