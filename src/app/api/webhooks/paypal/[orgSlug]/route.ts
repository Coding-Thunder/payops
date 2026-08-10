import { NextResponse, type NextRequest } from "next/server";

import { AuditAction, AuditEntity, RecordState } from "@/lib/constants/enums";
import { logger } from "@/lib/logger";
import { Organization } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import { supportsCapture } from "@/server/payments/gateways/paypal";
import { getGatewayForOrganization } from "@/server/payments/resolve-gateway";
import { recordAudit } from "@/server/services/audit.service";
import { kickPostCommitDrain } from "@/server/services/email-outbox.service";
import { processGatewayEvent } from "@/server/services/webhook.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ orgSlug: string }>;
}

const MAX_WEBHOOK_BODY = 64 * 1024;

function bad(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

/**
 * Per-organization PayPal webhook endpoint.
 *
 * Mirrors the Stripe one — organization in the URL, flat 404 for anything
 * unresolvable so the endpoint is not an oracle — with one behavioural
 * difference that matters:
 *
 *   CHECKOUT.ORDER.APPROVED DOES NOT MEAN PAID. PayPal separates approval
 *   from capture: the buyer approving authorises us to take the money, and
 *   nothing moves until an explicit capture call. So on APPROVED this route
 *   captures, and the resulting PAYMENT.CAPTURE.COMPLETED delivery is what
 *   actually flips the order to PAID. Treating APPROVED as payment would
 *   mark orders paid that were never charged.
 *
 * The capture is idempotent from our side: PayPal rejects a second capture
 * of the same order, and that rejection is logged and acked rather than
 * retried, because a duplicate APPROVED delivery is normal.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { orgSlug } = await params;

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

  await connectMongo();
  const org = await Organization.findOne({
    slug: orgSlug.toLowerCase(),
    status: RecordState.ACTIVE,
  })
    .select("_id slug")
    .lean<{ _id: unknown; slug: string } | null>();

  if (!org) {
    logger.warn("paypal.webhook.unknown_organization", { orgSlug });
    return bad(404, "NOT_FOUND", "Unknown endpoint");
  }

  let gateway;
  try {
    gateway = await getGatewayForOrganization(String(org._id));
  } catch (err) {
    logger.error("paypal.webhook.gateway_unavailable", {
      orgSlug,
      err: err instanceof Error ? err.message : String(err),
    });
    return bad(404, "NOT_FOUND", "Unknown endpoint");
  }

  if (gateway.key !== "PAYPAL") {
    // The organization is configured for a different provider; a PayPal
    // delivery here is a misconfiguration, not a valid event.
    logger.warn("paypal.webhook.provider_mismatch", {
      orgSlug,
      configured: gateway.key,
    });
    return bad(404, "NOT_FOUND", "Unknown endpoint");
  }

  let event;
  try {
    // Async on purpose: PayPal verification is a round trip to their
    // verify-webhook-signature endpoint, not a local HMAC.
    event = await gateway.verifyWebhook(rawBody, req.headers);
  } catch (err) {
    logger.warn("paypal.invalid_signature", {
      orgSlug,
      err: err instanceof Error ? err.message : String(err),
    });
    await recordAudit({
      action: AuditAction.WEBHOOK_FAILED,
      entityType: AuditEntity.WEBHOOK,
      metadata: {
        gateway: "PAYPAL",
        organizationSlug: org.slug,
        reason: "invalid_signature",
        err: err instanceof Error ? err.message : String(err),
      },
    });
    return bad(400, "BAD_REQUEST", "Invalid signature");
  }

  // Approval -> capture. Verified above, so this is a genuine PayPal event.
  const rawEvent = event.raw as { event_type?: string } | undefined;
  if (rawEvent?.event_type === "CHECKOUT.ORDER.APPROVED" && event.sessionId) {
    try {
      if (!supportsCapture(gateway)) {
        throw new Error("Gateway does not support capture");
      }
      await gateway.captureOrder(event.sessionId);
      logger.info("paypal.order.captured", {
        orgSlug,
        sessionId: event.sessionId,
      });
    } catch (err) {
      // A duplicate APPROVED delivery hits an already-captured order, which
      // PayPal rejects. That is expected, not an error worth retrying — ack
      // so PayPal stops replaying, and let the capture webhook do the work.
      logger.warn("paypal.capture_failed", {
        orgSlug,
        sessionId: event.sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    return NextResponse.json({
      ok: true,
      data: { received: true, captured: true },
    });
  }

  try {
    const result = await processGatewayEvent(event);
    kickPostCommitDrain();
    return NextResponse.json({ ok: true, data: { received: true, ...result } });
  } catch (err) {
    logger.error("paypal.processing_failed", {
      orgSlug,
      eventId: event.eventId,
      type: event.type,
      err: err instanceof Error ? err.message : String(err),
    });
    await recordAudit({
      action: AuditAction.WEBHOOK_FAILED,
      entityType: AuditEntity.WEBHOOK,
      entityId: event.eventId,
      metadata: {
        gateway: "PAYPAL",
        organizationSlug: org.slug,
        type: event.type,
        err: err instanceof Error ? err.message : String(err),
      },
    });
    return bad(500, "INTERNAL_ERROR", "Failed to process event");
  }
}
