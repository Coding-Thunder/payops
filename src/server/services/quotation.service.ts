import "server-only";

import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import type { ParsedQuotationInput } from "@/lib/validation";
import { Quotation, type QuotationDoc } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import { isEmailConfigured, sendEmail } from "@/server/email/send";

/**
 * Persist a quotation / enquiry request and best-effort dispatch an internal
 * notification email. Persistence is the source of truth: even with no
 * transport and no recipient configured, the lead is stored and reviewable
 * at /admin/quotations, and `notificationStatus` records exactly what
 * happened to the email so ops can re-drive failures.
 *
 * Three things this deliberately does NOT do:
 *  - claim a send it did not make (no recipient → SKIPPED, not SENT);
 *  - throw when email is misconfigured (that would lose a valid lead);
 *  - log the submitter's address (see `sendInternalNotification`).
 */
export interface SubmitQuotationContext {
  ip: string | null;
  userAgent: string | null;
}

export interface SubmitQuotationResult {
  id: string;
  notificationStatus: QuotationDoc["notificationStatus"];
  /** True when this collapsed onto an identical recent submission. */
  deduped: boolean;
}

/** Validated in `lib/env`; "" when neither is configured. */
function notificationRecipient(): string {
  return (env.server.SALES_EMAIL || env.server.SUPPORT_EMAIL || "").trim();
}

/**
 * How long an identical resubmission is treated as a double-click rather
 * than a new lead. Long enough to absorb an impatient second submit or a
 * retried request, short enough that a genuine follow-up later the same day
 * is still recorded as its own enquiry.
 */
const DEDUPE_WINDOW_MS = 10 * 60_000;

/** Same person, same source, same words — collapse rather than duplicate. */
function sameEnquiry(a: string | undefined, b: string): boolean {
  return (a ?? "").trim().replace(/\s+/g, " ") === b.trim().replace(/\s+/g, " ");
}

export async function submitQuotation(
  input: ParsedQuotationInput,
  ctx: SubmitQuotationContext,
): Promise<SubmitQuotationResult> {
  await connectMongo();

  // Accidental duplicate guard. A double-click, a retried request or an
  // impatient second submit lands here with identical content; treat it as
  // the same lead instead of creating a second row and sending a second
  // internal email. Scoped by email + source + message so a different
  // enquiry, or the same person writing again later, is still its own
  // record. Not a uniqueness constraint: this must never reject a lead, so
  // a lookup failure falls through to the insert.
  const since = new Date(Date.now() - DEDUPE_WINDOW_MS);
  const recent = await Quotation.findOne({
    workEmail: input.workEmail,
    source: input.source,
    createdAt: { $gte: since },
  })
    .sort({ createdAt: -1 })
    .catch(() => null);

  if (recent && sameEnquiry(recent.useCase, input.useCase)) {
    return {
      id: String(recent._id),
      notificationStatus: recent.notificationStatus,
      deduped: true,
    };
  }

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
    deduped: false,
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
  // No PII in logs. The record id is enough to find the lead in
  // /admin/quotations; the submitter's address is not log material.
  if (!isEmailConfigured()) {
    logger.warn("quotation.notification_skipped_no_transport", {
      quotationId: String(doc._id),
    });
    return {
      status: "SKIPPED",
      messageId: null,
      error: "email_not_configured",
    };
  }

  // A transport with nowhere to send is still a non-delivery. Record it as
  // SKIPPED rather than attempting a send to "" (which throws) or reporting
  // SENT (which would be a lie). The lead is already persisted, and the
  // status makes the gap visible to an admin.
  const recipient = notificationRecipient();
  if (!recipient) {
    logger.warn("quotation.notification_skipped_no_recipient", {
      quotationId: String(doc._id),
    });
    return {
      status: "SKIPPED",
      messageId: null,
      error: "no_recipient_configured",
    };
  }

  // Strip CR/LF from anything that lands in a header. Nodemailer encodes
  // Subject defensively but a CRLF in companyName / expectedVolume is
  // never legitimate; collapse to single space and cap length.
  const headerSafe = (s: string) =>
    s.replace(/[\r\n]+/g, " ").trim().slice(0, 200);
  // `expectedVolume` is empty for a general enquiry, so it is appended only
  // when present — otherwise the subject trails a bare comma.
  const volume = headerSafe(doc.expectedVolume ?? "");
  const subject = `[TraceTxn lead] ${headerSafe(doc.companyName ?? "")}${
    volume ? `, ${volume}` : ""
  }`;
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
    const info = await sendEmail({
      from: env.server.EMAIL_FROM,
      to: recipient,
      replyTo: doc.workEmail,
      subject,
      html,
      text,
      kind: "QUOTATION_LEAD",
      headers: { "X-TraceTxn-Lead": String(doc._id) },
    });
    return {
      status: "SENT",
      messageId: info.messageId,
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
