import { NextResponse, type NextRequest } from "next/server";

import {
  AuditAction,
  AuditEntity,
  PaymentGatewayKey,
} from "@/lib/constants/enums";
import { logger } from "@/lib/logger";
import { resolveOrganizationId } from "@/server/auth/organization";
import { supportsCapture } from "@/server/payments/gateways/paypal";
import {
  PaymentProviderNotConfiguredError,
  PaymentProviderNotEnabledError,
  getGatewayForOrganization,
} from "@/server/payments/resolve-gateway";
import { recordAudit } from "@/server/services/audit.service";
import { kickPostCommitDrain } from "@/server/services/email-outbox.service";
import { processGatewayEvent } from "@/server/services/webhook.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_WEBHOOK_BODY = 64 * 1024;

function bad(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

/**
 * The PayPal webhook endpoint.
 *
 * THE PROVIDER IS DECIDED BY THE ENDPOINT, NEVER BY CONFIGURATION — the same
 * rule the Stripe route states. This one pins PAYPAL explicitly rather than
 * asking the organization which provider it defaults to, because on a
 * deployment offering both, resolving by default would hand a genuine PayPal
 * delivery the Stripe adapter, fail verification, and leave the order
 * unpaid forever.
 *
 * Three things make PayPal different from Stripe here:
 *
 *  1. VERIFICATION IS A NETWORK CALL. There is no signing secret. The adapter
 *     calls PayPal back at /v1/notifications/verify-webhook-signature with
 *     the five transmission headers and the webhook id. It can fail for
 *     reasons that have nothing to do with authenticity — so a failure is
 *     treated exactly like a bad Stripe signature (400, audit row) and
 *     PayPal retries.
 *
 *  2. APPROVAL IS NOT PAYMENT. `CHECKOUT.ORDER.APPROVED` means the buyer
 *     authorised a capture; no money has moved. This route responds by
 *     CAPTURING, and the resulting `PAYMENT.CAPTURE.COMPLETED` delivery is
 *     what flips the order to PAID. Treating APPROVED as payment would mark
 *     orders paid that were never charged.
 *
 *  3. A DUPLICATE APPROVED IS NORMAL. PayPal replays. The second capture is
 *     rejected by PayPal itself, which is the idempotency guarantee — logged
 *     and acked rather than retried, because retrying cannot help.
 *
 * When PayPal is not switched on for the organization the route still
 * refuses, with 503 and no processing. That refusal is now CONDITIONAL on
 * the organization's `enabledProviders` rather than unconditional, which is
 * the whole difference between "this deployment does not do PayPal" and
 * "this deployment does PayPal and something is wrong".
 *
 * It must NEVER answer 200 without having processed the event: an
 * acknowledgement tells PayPal to stop retrying, and that is exactly how a
 * payment goes silently missing.
 *
 * Note for anyone reading production logs: DigitalOcean App Platform
 * replaces an upstream 503 with its own 504 error page, so a disabled
 * response arrives at the caller as 504 with HTML. The `x-do-orig-status`
 * header carries the real status.
 */
export async function POST(req: NextRequest) {
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

  let organizationId: string;
  try {
    organizationId = await resolveOrganizationId();
  } catch (err) {
    logger.error("paypal.webhook.organization_unresolved", {
      err: err instanceof Error ? err.message : String(err),
    });
    return bad(503, "PROVIDER_DISABLED", "PayPal is not available.");
  }

  // Pinned, not requested: an explicit refusal when PayPal is off beats a
  // silent substitution with whatever provider the organization defaults to.
  let gateway;
  try {
    gateway = await getGatewayForOrganization(organizationId, {
      kind: "pinned",
      provider: PaymentGatewayKey.PAYPAL,
    });
  } catch (err) {
    if (err instanceof PaymentProviderNotEnabledError) {
      logger.warn("paypal.webhook.provider_disabled", {
        organizationId,
        note: "PayPal delivery received while PayPal is not an enabled provider",
      });
      return bad(
        503,
        "PROVIDER_DISABLED",
        "PayPal is not enabled on this deployment.",
      );
    }
    if (err instanceof PaymentProviderNotConfiguredError) {
      // Enabled but missing credentials is an operator error, and a
      // materially different one — say so rather than blaming the flag.
      logger.error("paypal.webhook.provider_not_configured", {
        organizationId,
        err: err.message,
      });
      return bad(
        503,
        "PROVIDER_NOT_CONFIGURED",
        "PayPal is enabled but not fully configured.",
      );
    }
    throw err;
  }

  let event;
  try {
    // Async on purpose: this is a round trip to PayPal, not a local HMAC.
    event = await gateway.verifyWebhook(rawBody, req.headers);
  } catch (err) {
    logger.warn("paypal.invalid_signature", {
      organizationId,
      err: err instanceof Error ? err.message : String(err),
    });
    await recordAudit({
      action: AuditAction.WEBHOOK_FAILED,
      entityType: AuditEntity.WEBHOOK,
      metadata: {
        gateway: PaymentGatewayKey.PAYPAL,
        reason: "invalid_signature",
        err: err instanceof Error ? err.message : String(err),
      },
    });
    return bad(400, "BAD_REQUEST", "Invalid signature");
  }

  // Approval → capture. Verified above, so this is a genuine PayPal event.
  const rawEvent = event.raw as { event_type?: string } | undefined;
  if (rawEvent?.event_type === "CHECKOUT.ORDER.APPROVED" && event.sessionId) {
    try {
      if (!supportsCapture(gateway)) {
        throw new Error("Gateway does not support capture");
      }
      await gateway.captureOrder(event.sessionId);
      logger.info("paypal.order.captured", {
        organizationId,
        sessionId: event.sessionId,
      });
    } catch (err) {
      // A replayed APPROVED hits an already-captured order and PayPal
      // rejects it. Expected, and not worth retrying — ack so the replays
      // stop, and let PAYMENT.CAPTURE.COMPLETED do the actual work.
      logger.warn("paypal.capture_failed", {
        organizationId,
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
    const result = await processGatewayEvent(event, organizationId);
    kickPostCommitDrain();
    return NextResponse.json({ ok: true, data: { received: true, ...result } });
  } catch (err) {
    logger.error("paypal.processing_failed", {
      organizationId,
      eventId: event.eventId,
      type: event.type,
      err: err instanceof Error ? err.message : String(err),
    });
    await recordAudit({
      action: AuditAction.WEBHOOK_FAILED,
      entityType: AuditEntity.WEBHOOK,
      entityId: event.eventId,
      metadata: {
        gateway: PaymentGatewayKey.PAYPAL,
        type: event.type,
        err: err instanceof Error ? err.message : String(err),
      },
    });
    return bad(500, "INTERNAL_ERROR", "Failed to process event");
  }
}
