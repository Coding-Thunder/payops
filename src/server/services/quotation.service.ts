import "server-only";

import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import type { ParsedQuotationInput } from "@/lib/validation";
import { Quotation, type QuotationDoc } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import { getMailer } from "@/server/email/smtp";

/**
 * Persist an enterprise quotation request and best-effort dispatch an
 * internal notification email to the sales address. The persistence
 * step is the source of truth: even if SMTP is down, sales can review
 * leads at /admin/quotations. The notification status is stamped onto
 * the same record so ops can re-drive failed sends manually.
 */
export interface SubmitQuotationContext {
  ip: string | null;
  userAgent: string | null;
}

export interface SubmitQuotationResult {
  id: string;
  notificationStatus: QuotationDoc["notificationStatus"];
}

const NOTIFICATION_RECIPIENT =
  process.env.SALES_EMAIL?.trim() || env.server.SUPPORT_EMAIL;

export async function submitQuotation(
  input: ParsedQuotationInput,
  ctx: SubmitQuotationContext,
): Promise<SubmitQuotationResult> {
  await connectMongo();

  const created = await Quotation.create({
    fullName: input.fullName,
    companyName: input.companyName,
    workEmail: input.workEmail,
    phone: input.phone,
    country: input.country,
    expectedVolume: input.expectedVolume,
    preferredGateway: input.preferredGateway,
    currentStack: input.currentStack,
    useCase: input.useCase,
    timeline: input.timeline,
    customRequirements: input.customRequirements,
    notes: input.notes,
    source: input.source,
    status: "PENDING",
    notificationStatus: "SKIPPED",
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  const notification = await sendInternalNotification(created);
  if (notification) {
    created.notificationStatus = notification.status;
    created.notificationMessageId = notification.messageId;
    created.notificationError = notification.error;
    await created.save();
  }

  return {
    id: String(created._id),
    notificationStatus: created.notificationStatus,
  };
}

interface NotificationResult {
  status: QuotationDoc["notificationStatus"];
  messageId: string | null;
  error: string | null;
}

async function sendInternalNotification(
  doc: QuotationDoc & { _id: unknown },
): Promise<NotificationResult | null> {
  const mailer = getMailer();
  if (!mailer) {
    logger.warn("quotation.notification_skipped_no_smtp", {
      workEmail: doc.workEmail,
    });
    return { status: "SKIPPED", messageId: null, error: "smtp_not_configured" };
  }

  // Strip CR/LF from anything that lands in a header. Nodemailer encodes
  // Subject defensively but a CRLF in companyName / expectedVolume is
  // never legitimate; collapse to single space and cap length.
  const headerSafe = (s: string) =>
    s.replace(/[\r\n]+/g, " ").trim().slice(0, 200);
  const subject = `[TraceTxn lead] ${headerSafe(doc.companyName)}, ${headerSafe(doc.expectedVolume)}`;
  const lines = [
    `New TraceTxn quotation request`,
    ``,
    `Name      : ${doc.fullName}`,
    `Company   : ${doc.companyName}`,
    `Email     : ${doc.workEmail}`,
    `Phone     : ${doc.phone}`,
    `Country   : ${doc.country}`,
    `Volume    : ${doc.expectedVolume}`,
    `Gateway   : ${doc.preferredGateway || "-"}`,
    `Stack     : ${doc.currentStack || "-"}`,
    `Timeline  : ${doc.timeline || "-"}`,
    `Source    : ${doc.source}`,
    ``,
    `Use case`,
    `--------`,
    doc.useCase || "(not provided)",
    ``,
    `Custom requirements`,
    `-------------------`,
    doc.customRequirements || "(not provided)",
    ``,
    `Notes`,
    `-----`,
    doc.notes || "(not provided)",
    ``,
    `Captured from ${doc.ip ?? "unknown ip"} • ${doc.userAgent ?? "unknown ua"}`,
    `Record id: ${String(doc._id)}`,
  ];
  const text = lines.join("\n");
  const html = `<pre style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;line-height:1.55;white-space:pre-wrap">${escapeHtml(text)}</pre>`;

  try {
    const info = await mailer.sendMail({
      from: env.server.EMAIL_FROM,
      to: NOTIFICATION_RECIPIENT,
      replyTo: doc.workEmail,
      subject,
      html,
      text,
      headers: { "X-TraceTxn-Lead": String(doc._id) },
    });
    return {
      status: "SENT",
      messageId: info.messageId ?? null,
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("quotation.notification_failed", { err: message });
    return { status: "FAILED", messageId: null, error: message };
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
