import "server-only";

import { adminConsoleUrl, env } from "@/console/server/env";
import {
  EmailNotConfiguredError,
  isEmailConfigured,
  sendEmail,
} from "@/server/email/send";

/**
 * The console's four mails: the sign-in OTP, the beta invitation, the admin
 * welcome, and the "your access is ready" set-password link.
 *
 * This module used to own a second SMTP transport that mirrored
 * `src/server/email/smtp.ts`. That copy is why console sign-in broke in
 * production: when the app moved to Resend's HTTP API, only
 * `email.service.tsx` was migrated, so every OTP still went out over SMTP and
 * came back `535 Authentication credentials invalid`. Transport selection now
 * lives in exactly one place — `@/server/email/send` — and this module only
 * builds the message bodies.
 */

export { EmailNotConfiguredError };

function escapeHtml(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function sendOtpEmail(to: string, code: string): Promise<void> {
  const minutes = env.server.OTP_TTL_MINUTES;
  if (!isEmailConfigured()) {
    // Previously this logged the plaintext OTP and returned, so the endpoint
    // reported `sent: true` and the operator waited for an email that was
    // never sent — while the code sat in the runtime log. Both halves were
    // wrong. Fail loudly; the caller decides what the client sees.
    throw new EmailNotConfiguredError();
  }
  const html = `
    <p>Your ${escapeHtml(env.server.ADMIN_APP_NAME)} sign-in code is:</p>
    <p style="font-size:28px;font-weight:700;letter-spacing:4px;margin:12px 0">${code}</p>
    <p>It expires in ${minutes} minutes. If you didn't request it, ignore this email.</p>`;
  const text = `Your ${env.server.ADMIN_APP_NAME} sign-in code is: ${code}\nIt expires in ${minutes} minutes.`;
  await sendEmail({
    from: env.server.EMAIL_FROM_ACCOUNTS,
    to,
    replyTo: env.server.EMAIL_REPLY_TO,
    subject: `${env.server.ADMIN_APP_NAME} sign-in code: ${code}`,
    html,
    text,
    kind: "ADMIN_OTP",
  });
}

export async function sendBetaInvitationEmail(args: {
  to: string;
  name: string;
  /** Full activation URL incl. the raw single-use token. Never logged. */
  url: string;
}): Promise<void> {
  if (!isEmailConfigured()) {
    // Deliberately does NOT log the URL/token. A missing SMTP config in dev
    // surfaces the email address only; the raw invitation token never hits
    // the logs. Throw so the caller records a send failure (status stays
    // APPROVED, retryable) rather than a false INVITED.
    console.warn(
      `[admin] Beta invite for ${args.to} not sent (SMTP not configured).`,
    );
    throw new Error("Email is not configured");
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
  await sendEmail({
    from: env.server.EMAIL_FROM_ACCOUNTS,
    to: args.to,
    replyTo: env.server.EMAIL_REPLY_TO,
    subject: "You're in — activate your TraceTxn beta account",
    html,
    text,
    kind: "BETA_INVITE",
  });
}

export async function sendAdminWelcomeEmail(args: {
  to: string;
  name: string;
  invitedByEmail?: string | null;
}): Promise<void> {
  const url = adminConsoleUrl();
  const app = env.server.ADMIN_APP_NAME;
  if (!isEmailConfigured()) {
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
  await sendEmail({
    from: env.server.EMAIL_FROM_ACCOUNTS,
    to: args.to,
    replyTo: env.server.EMAIL_REPLY_TO,
    subject: `You've been added to the ${app} console`,
    html,
    text,
    kind: "ADMIN_WELCOME",
  });
}

export async function sendAccessLinkEmail(args: {
  to: string;
  name: string;
  url: string;
}): Promise<void> {
  if (!isEmailConfigured()) {
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
  await sendEmail({
    from: env.server.EMAIL_FROM_ACCOUNTS,
    to: args.to,
    replyTo: env.server.EMAIL_REPLY_TO,
    subject: "Your TraceTxn access is ready",
    html,
    text,
    kind: "ADMIN_ACCESS_GRANT",
  });
}
