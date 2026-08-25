import "server-only";

import {
  deliverViaResend,
  resendApiKey,
  type OutboundAttachment,
} from "@/server/email/resend";
import { getMailer } from "@/server/email/smtp";

export type { OutboundAttachment };

/**
 * The one place an email leaves this application.
 *
 * Why this exists: the move to Resend's HTTP API was applied to
 * `email.service.tsx` (payment-request / consent / template mail) and nowhere
 * else. Three senders kept their own nodemailer call — the console's four
 * mails, password reset, and the quotation lead notification — so they went
 * on opening an SMTP socket to smtp.resend.com with the `re_…` key as the
 * password. Resend's SMTP gateway rejects that key
 * (`535 Authentication credentials invalid`) even though its HTTP API accepts
 * it, so `/api/health` stayed green (it probes over HTTPS) while console
 * sign-in, password resets and lead alerts silently delivered nothing.
 *
 * The lesson is the duplication, not the transport: every sender now selects
 * its transport here, exactly once.
 *
 * Transport order is deliberate:
 *   1. Resend HTTPS  — port 443, never blocked/throttled by the platform,
 *                      fails fast with a typed status instead of hanging.
 *   2. SMTP          — only when no `re_` key is configured (self-hosted or
 *                      a non-Resend relay). Not a fallback *after* a Resend
 *                      failure: both paths use the same credential, so
 *                      retrying over SMTP would turn one clear 401 into a
 *                      second, slower, less legible 535.
 */

export class EmailNotConfiguredError extends Error {
  constructor() {
    super(
      "Email transport is not configured (set RESEND_API_KEY, or SMTP_HOST/SMTP_USER/SMTP_PASS)",
    );
    this.name = "EmailNotConfiguredError";
  }
}

export interface OutboundEmail {
  from: string;
  to: string;
  replyTo?: string | null;
  subject: string;
  html: string;
  text?: string;
  /** X-Entity-Kind value — classification for provider-side filtering. */
  kind: string;
  /** Additional headers; carried by both transports. */
  headers?: Record<string, string>;
  /** Files to send along with the message. Both transports carry them;
   *  the CALLER is responsible for keeping the combined size inside
   *  MAX_EMAIL_ATTACHMENT_TOTAL_BYTES, because a provider-side size
   *  rejection is opaque and arrives after the operator hit Send. */
  attachments?: readonly OutboundAttachment[];
}

export interface SendResult {
  messageId: string | null;
  transport: "resend-http" | "smtp";
  /** Raw transport acknowledgement, recorded on the audit row. */
  response: string | null;
}

/**
 * True when *some* transport can deliver. Callers use this to decide between
 * "log the link, this is dev" and "fail loudly, this is production" — the
 * check they used to make with `getMailer() !== null`, which was wrong the
 * moment Resend became the primary transport.
 */
export function isEmailConfigured(): boolean {
  return resendApiKey() !== null || getMailer() !== null;
}

/**
 * Collapse anything that could break out of a header value.
 *
 * A subject is a single line by definition, but `.trim()` only strips the
 * ends — an embedded CRLF survives it, and one can also arrive through a
 * resolved variable (a client record whose name contains a newline). Both
 * current transports happen to mitigate this (Resend takes a JSON body;
 * nodemailer encodes headers), but "the transport probably handles it" is
 * not the same as handling it. This is the one place mail leaves the
 * application, so it is the right place to guarantee it.
 */
function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/** Deliver one email. Throws on failure; never returns a false success. */
export async function sendEmail(msg: OutboundEmail): Promise<SendResult> {
  const key = resendApiKey();
  const subject = singleLine(msg.subject);
  if (key) {
    const { id } = await deliverViaResend(key, {
      from: msg.from,
      to: msg.to,
      replyTo: msg.replyTo,
      subject,
      html: msg.html,
      text: msg.text,
      kind: msg.kind,
      headers: msg.headers,
      attachments: msg.attachments,
    });
    return { messageId: id, transport: "resend-http", response: "resend-http" };
  }

  const mailer = getMailer();
  if (!mailer) throw new EmailNotConfiguredError();
  const info = await mailer.sendMail({
    from: msg.from,
    to: msg.to,
    replyTo: msg.replyTo || undefined,
    subject,
    html: msg.html,
    text: msg.text,
    headers: { "X-Entity-Kind": msg.kind, ...(msg.headers ?? {}) },
    attachments: msg.attachments?.length
      ? msg.attachments.map((a) => ({
          filename: a.fileName,
          content: a.content,
          contentType: a.contentType,
        }))
      : undefined,
  });
  return {
    messageId: info.messageId ?? null,
    transport: "smtp",
    response: info.response ?? null,
  };
}
