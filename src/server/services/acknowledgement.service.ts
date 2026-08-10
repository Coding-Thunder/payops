import "server-only";

import { Types } from "mongoose";

import {
  AuditAction,
  AuditEntity,
  OrderEvidenceActorType,
  OrderEvidenceEventType,
} from "@/lib/constants/enums";
import { BadRequestError, NotFoundError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { Order } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import {
  resolveEmailIdentity,
  resolvePublicBrand,
} from "@/server/email/identity";
import { getMailer, getMailerFor } from "@/server/email/smtp";
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
  // The brand on this page must be the one that emailed the customer here.
  // Reading the deployment Branding singleton showed every tenant's customer
  // "Rental Confirmation" and its support address; the default organization
  // still resolves to exactly that singleton, so nothing changes for it.
  const brand = await resolvePublicBrand(
    doc.organizationId ? String(doc.organizationId) : null,
    await getBranding(),
  );
  return {
    orderNumber: doc.orderNumber,
    customerName: doc.customer.name,
    brandName: brand.brandName,
    supportEmail: brand.supportEmail,
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
    orderId: String(doc._id),
    organizationId: doc.organizationId ? String(doc.organizationId) : null,
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
  orderId: string;
  organizationId: string | null;
  orderNumber: string;
  customerName: string;
  customerEmail: string;
  confirmationNumber: string | null;
  termsVersion: string;
  acknowledgedAt: Date;
  ip: string | null;
  userAgent: string | null;
}

/** Bare address out of an RFC-5322 `Name <addr>` header. */
function addressOf(header: string): string {
  const match = header.match(/<([^>]+)>/);
  return (match ? match[1] : header).trim();
}

/**
 * The internal mailbox that receives the "customer accepted the terms"
 * confirmation.
 *
 * The rule is unchanged — it is the brand's own SENDING address — but it is
 * now the sending address of the organization that owns the order, not the
 * deployment's. Previously every brand's acknowledgement landed in
 * billing@rentalconfirmation.com, so a Trip Reservations operator never saw
 * that their customer had accepted.
 *
 * Precedence: per-organization env override → the deployment-wide
 * ACK_NOTIFICATION_EMAIL (default organization only, so the existing escape
 * hatch keeps working exactly as documented) → the brand's own From address.
 */
function opsNotificationRecipient(
  slug: string | null,
  isDefault: boolean,
  from: string,
): string {
  if (slug) {
    const perOrg =
      process.env[
        `ORG_${slug.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_ACK_NOTIFICATION_EMAIL`
      ]?.trim();
    if (perOrg) return perOrg;
  }
  if (isDefault) {
    const override = process.env.ACK_NOTIFICATION_EMAIL?.trim();
    if (override) return override;
  }
  return addressOf(from);
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
    const branding = await getBranding();
    // Same resolution the customer's own confirmation email went through, so
    // the notification leaves the brand's own mailbox and lands back in it.
    const [identity, brand] = await Promise.all([
      resolveEmailIdentity(n.organizationId, branding),
      resolvePublicBrand(n.organizationId, branding),
    ]);
    const mailer = identity.transport
      ? getMailerFor(identity.transport)
      : getMailer();
    if (!mailer) {
      logger.warn("ack.notification_skipped_no_smtp", {
        orderNumber: n.orderNumber,
        organizationId: n.organizationId,
      });
      return;
    }
    const to = opsNotificationRecipient(
      brand.slug,
      brand.isDefault,
      identity.from,
    );
    const headerSafe = (s: string) =>
      s.replace(/[\r\n]+/g, " ").trim().slice(0, 200);
    // The brand is in the subject because one operator watches both
    // mailboxes; without it two brands' acknowledgements are indistinguishable
    // at a glance.
    const subject = `[Terms accepted] ${headerSafe(brand.brandName)} • ${headerSafe(n.orderNumber)} — ${headerSafe(n.customerName)}`;
    const text = [
      `Customer accepted the booking Terms & Conditions.`,
      ``,
      `Brand         : ${brand.brandName}`,
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
      from: identity.from,
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
      organizationId: n.organizationId,
      to,
      messageId: info.messageId ?? null,
    });
    // Audited so the order timeline shows the notification went out. Its
    // absence is what made this failure invisible: the send only ever logged,
    // so an operator had no way to tell a missing email from a missing click.
    await recordAudit({
      action: AuditAction.EMAIL_SENT,
      entityType: AuditEntity.ORDER,
      entityId: n.orderId,
      metadata: {
        kind: "TERMS_ACKNOWLEDGED_OPS",
        to,
        from: identity.from,
        brand: brand.brandName,
        messageId: info.messageId ?? null,
      },
    });
  } catch (err) {
    logger.error("ack.notification_failed", {
      orderNumber: n.orderNumber,
      organizationId: n.organizationId,
      err: err instanceof Error ? err.message : String(err),
    });
    await recordAudit({
      action: AuditAction.EMAIL_FAILED,
      entityType: AuditEntity.ORDER,
      entityId: n.orderId,
      metadata: {
        kind: "TERMS_ACKNOWLEDGED_OPS",
        error: err instanceof Error ? err.message : String(err),
      },
    }).catch(() => {
      /* the notification is best-effort; auditing its failure must not throw */
    });
  }
}
