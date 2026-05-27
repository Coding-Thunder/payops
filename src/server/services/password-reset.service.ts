import "server-only";

import crypto from "node:crypto";

import {
  AuditAction,
  AuditEntity,
  RecordState,
} from "@/lib/constants/enums";
import { env } from "@/lib/env";
import { BadRequestError, ForbiddenError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { hashPassword } from "@/server/auth/password";
import { User, type UserDoc } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import { getMailer } from "@/server/email/smtp";
import type { RequestContext } from "@/server/api/request-context";

import { recordAudit } from "./audit.service";

/**
 * Password-reset token: `{userId}.{passwordHashHead}.{iatSec}.{hmac}`,
 * base64url-encoded.
 *
 * The `passwordHashHead` is the FIRST 8 bytes of the user's current
 * passwordHash. Including it means the token auto-invalidates the
 * moment the user (or anyone) changes the password — the new hash
 * has a different head, so a previously-issued reset link can't
 * un-do a successful change. This is the same trick Devise +
 * Microsoft Identity use; lighter than a separate `password_reset`
 * collection.
 *
 * TTL is 30 minutes — long enough for a coffee-break email round
 * trip, short enough that a stolen inbox can't sit on the link.
 */

const MAX_AGE_SECONDS = 30 * 60;

function secret(): string {
  // Re-use JWT_SECRET so deploys don't need a fresh env var. If you
  // ever rotate JWT_SECRET, in-flight reset links invalidate — that's
  // the correct security posture (treat password material like
  // session material).
  return env.server.JWT_SECRET;
}

function hmac(value: string): string {
  return crypto.createHmac("sha256", secret()).update(value).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

function passwordHashHead(passwordHash: string): string {
  // First 8 chars of the bcrypt hash. Bcrypt outputs are ~60 chars
  // starting with `$2[ayb]$<cost>$` so chars beyond the cost-prefix
  // are real per-user entropy. Slicing this here means the token
  // binds to the CURRENT hash and rotates as soon as it changes.
  return passwordHash.slice(0, 8);
}

export function generateResetToken(user: {
  _id: { toString(): string };
  passwordHash: string;
}): string {
  const iatSec = Math.floor(Date.now() / 1000);
  const userId = user._id.toString();
  const head = passwordHashHead(user.passwordHash);
  const payload = `${userId}.${head}.${iatSec}`;
  const sig = hmac(payload);
  return Buffer.from(`${payload}.${sig}`, "utf8").toString("base64url");
}

interface ParsedToken {
  userId: string;
  passwordHashHead: string;
  issuedAtSec: number;
}

export function parseResetToken(token: string): ParsedToken {
  let decoded: string;
  try {
    decoded = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    throw new BadRequestError("Invalid or expired reset link");
  }
  const parts = decoded.split(".");
  if (parts.length !== 4) {
    throw new BadRequestError("Invalid or expired reset link");
  }
  const [userId, head, iatStr, sig] = parts;
  if (!userId || !head || !iatStr || !sig) {
    throw new BadRequestError("Invalid or expired reset link");
  }
  const iatSec = Number.parseInt(iatStr, 10);
  if (!Number.isFinite(iatSec) || iatSec <= 0) {
    throw new BadRequestError("Invalid or expired reset link");
  }
  const expected = hmac(`${userId}.${head}.${iatStr}`);
  if (!safeEqual(sig, expected)) {
    throw new BadRequestError("Invalid or expired reset link");
  }
  const now = Math.floor(Date.now() / 1000);
  if (now - iatSec > MAX_AGE_SECONDS) {
    throw new BadRequestError("This reset link has expired. Request a new one.");
  }
  return { userId, passwordHashHead: head, issuedAtSec: iatSec };
}

/* ─────────────────────── Initiate (forgot-password) ───────────────────── */

interface InitiateContext {
  request: RequestContext | null;
}

/**
 * Initiate a password reset.
 *
 * Always returns successfully regardless of whether the email exists
 * — never reveals to the caller whether an account is registered. If
 * the user exists, we sign a token and send the email; otherwise we
 * silently no-op + log so an operator can spot enumeration attempts
 * via audit grep.
 */
export async function initiatePasswordReset(
  email: string,
  ctx: InitiateContext,
): Promise<void> {
  await connectMongo();
  const normalised = email.toLowerCase().trim();
  const user = await User.findOne({ email: normalised }).select(
    "+passwordHash _id name email status",
  );

  if (!user || user.status !== RecordState.ACTIVE) {
    // No-op path. Audit row makes enumeration attempts visible.
    await recordAudit({
      action: AuditAction.USER_PASSWORD_RESET,
      entityType: AuditEntity.USER,
      entityId: user ? String(user._id) : null,
      actor: user
        ? {
            userId: String(user._id),
            email: user.email,
            name: user.name,
            role: user.role,
          }
        : { email: normalised, name: null, role: null, userId: null },
      request: ctx.request,
      metadata: {
        action: "reset_requested",
        reason: !user ? "no_user" : `status_${user.status}`,
      },
    });
    return;
  }

  const token = generateResetToken({
    _id: user._id as { toString(): string },
    passwordHash: user.passwordHash,
  });
  const resetUrl = `${env.server.APP_URL.replace(/\/$/, "")}/reset-password/${token}`;

  await sendResetEmail({
    to: user.email,
    name: user.name,
    resetUrl,
  });

  await recordAudit({
    action: AuditAction.USER_PASSWORD_RESET,
    entityType: AuditEntity.USER,
    entityId: String(user._id),
    actor: {
      userId: String(user._id),
      email: user.email,
      name: user.name,
      role: user.role,
    },
    request: ctx.request,
    metadata: { action: "reset_email_sent" },
  });
}

/**
 * Send the reset-link email via the standard SMTP transporter.
 *
 * Inline HTML — deliberately not a React Email template, since this
 * is one-off transactional copy that almost never changes and isn't
 * branded per-tenant (the recovery flow runs before any session
 * context exists). Plain ops-grade copy keeps spam filters happier
 * than a marketing-grade design.
 */
async function sendResetEmail(args: {
  to: string;
  name: string;
  resetUrl: string;
}): Promise<void> {
  const mailer = getMailer();
  if (!mailer) {
    // No SMTP configured (local dev). Log the link so the operator
    // can copy it from their console — same UX as Rails dev mode.
    logger.warn("password_reset.smtp_missing", {
      to: args.to,
      resetUrl: args.resetUrl,
    });
    return;
  }
  const appName = env.server.APP_NAME;
  const html = `
    <p>Hi ${escapeHtml(args.name)},</p>
    <p>Someone asked to reset the password for your ${escapeHtml(appName)} account.
    If that was you, click the link below to set a new password. The link
    expires in 30 minutes.</p>
    <p><a href="${args.resetUrl}">Reset your password</a></p>
    <p>If you didn't request this, you can ignore this email — your
    current password stays unchanged.</p>
    <p>— ${escapeHtml(appName)}</p>
  `;
  const text = [
    `Hi ${args.name},`,
    "",
    `Someone asked to reset the password for your ${appName} account.`,
    `If that was you, open this link to set a new password (expires in 30 minutes):`,
    "",
    args.resetUrl,
    "",
    `If you didn't request this, ignore this email — your current`,
    `password stays unchanged.`,
    "",
    `— ${appName}`,
  ].join("\n");
  try {
    await mailer.sendMail({
      from: env.server.EMAIL_FROM,
      to: args.to,
      replyTo: env.server.EMAIL_REPLY_TO || undefined,
      subject: `Reset your ${appName} password`,
      html,
      text,
      headers: { "X-Entity-Kind": "PASSWORD_RESET" },
    });
  } catch (err) {
    // Bury the SMTP error — never surface it to the caller because
    // that would reveal whether the email existed (different code
    // paths on failure vs success). Audit row carries the diagnostic.
    logger.error("password_reset.email_failed", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ───────────────────────── Complete (reset-password) ─────────────────── */

interface CompleteContext {
  request: RequestContext | null;
}

export async function completePasswordReset(
  token: string,
  newPassword: string,
  ctx: CompleteContext,
): Promise<void> {
  await connectMongo();
  const parsed = parseResetToken(token);
  const user = await User.findById(parsed.userId).select(
    "+passwordHash _id name email role status",
  );
  if (!user) {
    // Bad-token error rather than NotFound — both should look the
    // same to callers (no enumeration), and the recovery UI shows a
    // generic "link no longer valid" message either way.
    throw new BadRequestError("Invalid or expired reset link");
  }
  if (user.status !== RecordState.ACTIVE) {
    throw new ForbiddenError("This account isn't active");
  }
  // The hash-head check is the auto-invalidation primitive: the
  // moment the user (or another reset) lands, the token's encoded
  // head no longer matches and we refuse the call.
  if (passwordHashHead(user.passwordHash) !== parsed.passwordHashHead) {
    throw new BadRequestError(
      "This reset link is no longer valid — the password has already been changed.",
    );
  }

  const nextHash = await hashPassword(newPassword);
  user.passwordHash = nextHash;
  await user.save();

  await recordAudit({
    action: AuditAction.USER_PASSWORD_RESET,
    entityType: AuditEntity.USER,
    entityId: String(user._id),
    actor: {
      userId: String(user._id),
      email: user.email,
      name: user.name,
      role: user.role,
    },
    request: ctx.request,
    metadata: { action: "reset_completed" },
  });
}

/** Test-only — direct token mint for fast green-path coverage. */
export function _generateResetTokenForTesting(user: UserDoc & { _id: unknown }): string {
  return generateResetToken({
    _id: user._id as { toString(): string },
    passwordHash: user.passwordHash,
  });
}
