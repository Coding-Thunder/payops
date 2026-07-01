import "server-only";

import { Types } from "mongoose";

import {
  AuditAction,
  AuditEntity,
  OrderEvidenceActorType,
  OrderEvidenceEventType,
} from "@/lib/constants/enums";
import { BadRequestError, NotFoundError } from "@/lib/errors";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { Order } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import { getMailer } from "@/server/email/smtp";
import type { RequestContext } from "@/server/api/request-context";

import { recordAudit } from "./audit.service";
import { captureEvidenceSafe } from "./evidence.service";
import { getBranding } from "./branding.service";
import { parseAckToken } from "./ack-token";

/** Trimmed view rendered by the public /acknowledge/[token] page. Never leaks
 *  audit metadata (IP / UA) back to the customer. */
export interface PublicAcknowledgementView {
  orderNumber: string;
  customerName: string;
  brandName: string;
  supportEmail: string;
  termsText: string;
  termsVersion: string;
  acknowledgedAt: string | null;
}

async function loadOrderByAckToken(token: string) {
  await connectMongo();
  const { orderId } = parseAckToken(token);
  if (!Types.ObjectId.isValid(orderId)) {
    throw new BadRequestError("Invalid acknowledgement token");
  }
  const doc = await Order.findById(orderId);
  if (!doc) throw new NotFoundError("Booking not found");
  return doc;
}

export async function getPublicAcknowledgementView(
  token: string,
): Promise<PublicAcknowledgementView> {
  const doc = await loadOrderByAckToken(token);
  const branding = await getBranding();
  return {
    orderNumber: doc.orderNumber,
    customerName: doc.customer.name,
    brandName: branding.brandName,
    supportEmail: branding.supportEmail,
    termsText: doc.terms?.text ?? "",
    termsVersion: doc.terms?.version ?? "v1",
    acknowledgedAt: doc.termsAcknowledgement?.acknowledgedAt
      ? doc.termsAcknowledgement.acknowledgedAt.toISOString()
      : null,
  };
}

/**
 * Record the customer's post-payment "I Agree" acknowledgement of the T&C
 * shown in the confirmation email. Idempotent — a re-click returns the
 * existing state without re-stamping. Captures IP + UA server-side and writes
 * an append-only evidence event for dispute defense.
 */
export async function recordTermsAcknowledgement(
  token: string,
  ctx: { request?: RequestContext | null },
): Promise<PublicAcknowledgementView> {
  const doc = await loadOrderByAckToken(token);

  if (doc.termsAcknowledgement?.acknowledgedAt) {
    return getPublicAcknowledgementView(token);
  }

  const now = new Date();
  doc.termsAcknowledgement = {
    acknowledgedAt: now,
    ip: ctx.request?.ip ?? null,
    userAgent: ctx.request?.userAgent ?? null,
  };
  await doc.save();

  await recordAudit({
    action: AuditAction.ORDER_UPDATED,
    entityType: AuditEntity.ORDER,
    entityId: String(doc._id),
    actor: {
      userId: null,
      name: doc.customer.name,
      email: doc.customer.email,
      role: null,
    },
    request: ctx.request ?? null,
    metadata: {
      action: "terms_acknowledged",
      orderNumber: doc.orderNumber,
      termsVersion: doc.terms?.version ?? "v1",
    },
  });

  await captureEvidenceSafe({
    orderId: String(doc._id),
    orderNumber: doc.orderNumber,
    eventType: OrderEvidenceEventType.TERMS_ACKNOWLEDGED,
    occurredAt: now,
    actor: {
      type: OrderEvidenceActorType.CUSTOMER,
      name: doc.customer.name,
      email: doc.customer.email,
    },
    request: ctx.request ?? null,
    payload: {
      termsVersion: doc.terms?.version ?? "v1",
      termsText: doc.terms?.text ?? "",
      acknowledgedAt: now.toISOString(),
    },
    refs: { customerEmail: doc.customer.email },
  });

  // Best-effort internal confirmation to the ops mailbox (billing@…) that the
  // customer accepted the terms. Runs only on the first-time acknowledgement
  // (duplicate clicks return early above) and never blocks the flow.
  await notifyOpsOfAcknowledgement({
    orderNumber: doc.orderNumber,
    customerName: doc.customer.name,
    customerEmail: doc.customer.email,
    confirmationNumber: doc.confirmationNumber ?? null,
    termsVersion: doc.terms?.version ?? "v1",
    acknowledgedAt: now,
    ip: ctx.request?.ip ?? null,
    userAgent: ctx.request?.userAgent ?? null,
  });

  return getPublicAcknowledgementView(token);
}

interface AckOpsNotification {
  orderNumber: string;
  customerName: string;
  customerEmail: string;
  confirmationNumber: string | null;
  termsVersion: string;
  acknowledgedAt: Date;
  ip: string | null;
  userAgent: string | null;
}

/**
 * The internal mailbox that receives the "customer accepted the terms"
 * confirmation. Defaults to the sending address parsed out of EMAIL_FROM
 * (e.g. billing@rentalconfirmation.com); override with ACK_NOTIFICATION_EMAIL.
 */
function opsNotificationRecipient(): string {
  const override = process.env.ACK_NOTIFICATION_EMAIL?.trim();
  if (override) return override;
  const from = env.server.EMAIL_FROM;
  const match = from.match(/<([^>]+)>/);
  return (match ? match[1] : from).trim();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Best-effort: email the ops mailbox when a customer clicks "I Agree", as a
 * confirmation of acceptance. NEVER throws — a failed notification must not
 * fail the acknowledgement (which is already persisted + in the evidence
 * chain). Sent as an internal plain notification, not a branded customer email.
 */
async function notifyOpsOfAcknowledgement(
  n: AckOpsNotification,
): Promise<void> {
  try {
    const mailer = getMailer();
    if (!mailer) {
      logger.warn("ack.notification_skipped_no_smtp", {
        orderNumber: n.orderNumber,
      });
      return;
    }
    const to = opsNotificationRecipient();
    const headerSafe = (s: string) =>
      s.replace(/[\r\n]+/g, " ").trim().slice(0, 200);
    const subject = `[Terms accepted] ${headerSafe(n.orderNumber)} — ${headerSafe(n.customerName)}`;
    const text = [
      `Customer accepted the booking Terms & Conditions.`,
      ``,
      `Order         : ${n.orderNumber}`,
      `Customer      : ${n.customerName} <${n.customerEmail}>`,
      `Confirmation# : ${n.confirmationNumber || "—"}`,
      `Terms version : ${n.termsVersion}`,
      `Accepted at   : ${n.acknowledgedAt.toISOString()}`,
      `IP            : ${n.ip ?? "—"}`,
      `User agent    : ${n.userAgent ?? "—"}`,
    ].join("\n");
    const html = `<pre style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;line-height:1.55;white-space:pre-wrap">${escapeHtml(text)}</pre>`;
    const info = await mailer.sendMail({
      from: env.server.EMAIL_FROM,
      to,
      // Reply lands on the customer so ops can follow up directly.
      replyTo: n.customerEmail,
      subject,
      html,
      text,
      headers: { "X-Entity-Kind": "TERMS_ACKNOWLEDGED" },
    });
    logger.info("ack.notification_sent", {
      orderNumber: n.orderNumber,
      to,
      messageId: info.messageId ?? null,
    });
  } catch (err) {
    logger.error("ack.notification_failed", {
      orderNumber: n.orderNumber,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
