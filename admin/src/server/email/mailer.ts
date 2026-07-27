import "server-only";

import nodemailer, { type Transporter } from "nodemailer";

import { env } from "@/server/env";

/**
 * SMTP transport for the two mails this console sends: the sign-in OTP
 * and the "your access is ready" set-password link. Mirrors the main
 * app's `src/server/email/smtp.ts`; returns null when SMTP is unset (dev)
 * so the caller can log the code/link to the console instead.
 */
let cached: Transporter | null = null;

export function getMailer(): Transporter | null {
  const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS } = env.server;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  if (cached) return cached;
  cached = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: { user: SMTP_USER, pass: SMTP_PASS.replace(/\s+/g, "") },
    connectionTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return cached;
}

function escapeHtml(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function sendOtpEmail(to: string, code: string): Promise<void> {
  const mailer = getMailer();
  const minutes = env.server.OTP_TTL_MINUTES;
  if (!mailer) {
    // Dev fallback: no SMTP — surface the code in the server log.
    console.warn(`[admin] OTP for ${to}: ${code} (SMTP not configured)`);
    return;
  }
  const html = `
    <p>Your ${escapeHtml(env.server.APP_NAME)} sign-in code is:</p>
    <p style="font-size:28px;font-weight:700;letter-spacing:4px;margin:12px 0">${code}</p>
    <p>It expires in ${minutes} minutes. If you didn't request it, ignore this email.</p>`;
  const text = `Your ${env.server.APP_NAME} sign-in code is: ${code}\nIt expires in ${minutes} minutes.`;
  await mailer.sendMail({
    from: env.server.EMAIL_FROM_ACCOUNTS,
    to,
    replyTo: env.server.EMAIL_REPLY_TO || undefined,
    subject: `${env.server.APP_NAME} sign-in code: ${code}`,
    html,
    text,
    headers: { "X-Entity-Kind": "ADMIN_OTP" },
  });
}

export async function sendBetaInvitationEmail(args: {
  to: string;
  name: string;
  /** Full activation URL incl. the raw single-use token. Never logged. */
  url: string;
}): Promise<void> {
  const mailer = getMailer();
  if (!mailer) {
    // Deliberately does NOT log the URL/token. A missing SMTP config in dev
    // surfaces the email address only; the raw invitation token never hits
    // the logs. Throw so the caller records a send failure (status stays
    // APPROVED, retryable) rather than a false INVITED.
    console.warn(
      `[admin] Beta invite for ${args.to} not sent (SMTP not configured).`,
    );
    throw new Error("Email is not configured (SMTP unset)");
  }
  const html = `
    <p>Hi ${escapeHtml(args.name)},</p>
    <p>You've been approved for the TraceTxn private beta. Use the private link below to activate your account and set your password:</p>
    <p><a href="${args.url}">Activate your TraceTxn account</a></p>
    <p>This link is single-use and expires in 7 days. If you didn't apply, you can ignore this email.</p>`;
  const text = [
    `Hi ${args.name},`,
    "",
    "You've been approved for the TraceTxn private beta. Use the private link below to activate your account and set your password:",
    args.url,
    "",
    "This link is single-use and expires in 7 days. If you didn't apply, ignore this email.",
  ].join("\n");
  await mailer.sendMail({
    from: env.server.EMAIL_FROM_ACCOUNTS,
    to: args.to,
    replyTo: env.server.EMAIL_REPLY_TO || undefined,
    subject: "You're in — activate your TraceTxn beta account",
    html,
    text,
    headers: { "X-Entity-Kind": "BETA_INVITE" },
  });
}

export async function sendAdminWelcomeEmail(args: {
  to: string;
  name: string;
  invitedByEmail?: string | null;
}): Promise<void> {
  const mailer = getMailer();
  const url = env.server.ADMIN_APP_URL;
  const app = env.server.APP_NAME;
  if (!mailer) {
    console.warn(
      `[admin] Welcome email for ${args.to} skipped (SMTP not configured). Sign-in: ${url}`,
    );
    return;
  }
  const invitedBy = args.invitedByEmail
    ? `<p>You were added by ${escapeHtml(args.invitedByEmail)}.</p>`
    : "";
  const html = `
    <p>Hi ${escapeHtml(args.name)},</p>
    <p>You've been given access to the ${escapeHtml(app)} console.</p>
    <p>Sign in at <a href="${url}">${escapeHtml(url)}</a> using this email address — we'll email you a one-time sign-in code each time.</p>
    ${invitedBy}
    <p>If you weren't expecting this, you can ignore this email.</p>`;
  const text = [
    `Hi ${args.name},`,
    "",
    `You've been given access to the ${app} console.`,
    `Sign in at ${url} using this email address — we'll email you a one-time sign-in code each time.`,
    args.invitedByEmail ? `You were added by ${args.invitedByEmail}.` : "",
    "",
    "If you weren't expecting this, ignore this email.",
  ]
    .filter(Boolean)
    .join("\n");
  await mailer.sendMail({
    from: env.server.EMAIL_FROM_ACCOUNTS,
    to: args.to,
    replyTo: env.server.EMAIL_REPLY_TO || undefined,
    subject: `You've been added to the ${app} console`,
    html,
    text,
    headers: { "X-Entity-Kind": "ADMIN_WELCOME" },
  });
}

export async function sendAccessLinkEmail(args: {
  to: string;
  name: string;
  url: string;
}): Promise<void> {
  const mailer = getMailer();
  if (!mailer) {
    console.warn(`[admin] Access link for ${args.to}: ${args.url} (SMTP not configured)`);
    return;
  }
  const html = `
    <p>Hi ${escapeHtml(args.name)},</p>
    <p>Your TraceTxn access is ready. Set your password to sign in:</p>
    <p><a href="${args.url}">Set your password</a></p>
    <p>This link expires in 30 minutes.</p>`;
  const text = [
    `Hi ${args.name},`,
    "",
    "Your TraceTxn access is ready. Set your password to sign in:",
    args.url,
    "",
    "This link expires in 30 minutes.",
  ].join("\n");
  await mailer.sendMail({
    from: env.server.EMAIL_FROM_ACCOUNTS,
    to: args.to,
    replyTo: env.server.EMAIL_REPLY_TO || undefined,
    subject: "Your TraceTxn access is ready",
    html,
    text,
    headers: { "X-Entity-Kind": "ADMIN_ACCESS_GRANT" },
  });
}
