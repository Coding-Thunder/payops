import "server-only";

import crypto from "node:crypto";

import { env } from "@/console/server/env";
import { connectMongo } from "@/console/server/db/mongoose";
import { AdminOtp, type AdminOtpDoc } from "@/console/server/db/models";
import { normalizeEmail } from "./allowlist";

/**
 * Email one-time-code, stored HASHED at rest (HMAC-SHA256 with the
 * app secret + the email as salt). Single live code per email (re-issue
 * replaces), short TTL, capped attempts, single-use (deleted on the first
 * correct match). A Mongo TTL index also sweeps expired rows.
 */
function secret(): string {
  return env.server.ADMIN_SESSION_SECRET || env.server.JWT_SECRET;
}

function hashCode(email: string, code: string): string {
  return crypto
    .createHmac("sha256", secret())
    .update(`${normalizeEmail(email)}:${code}`)
    .digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function generateCode(): string {
  // 6 digits, crypto-strong, zero-padded.
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
}

/** Create (or replace) the live OTP for an email and return the raw code
 *  so the caller can email it. */
export async function issueOtp(email: string): Promise<string> {
  await connectMongo();
  const normalized = normalizeEmail(email);
  const code = generateCode();
  const ttlMs = env.server.OTP_TTL_MINUTES * 60 * 1000;
  const expiresAt = new Date(Date.now() + ttlMs);
  await AdminOtp.updateOne(
    { email: normalized },
    {
      $set: {
        email: normalized,
        codeHash: hashCode(normalized, code),
        expiresAt,
        attempts: 0,
        createdAt: new Date(),
      },
    },
    { upsert: true },
  );
  return code;
}

export type OtpResult = "ok" | "invalid" | "expired" | "too_many_attempts";

/**
 * Verify a submitted code. Consumes the OTP on success.
 *
 * The attempt cap is enforced with a SINGLE atomic `findOneAndUpdate`
 * that both checks `attempts < MAX` and `$inc`s it, so a burst of
 * concurrent guesses can never each read the same stale counter and slip
 * past the cap (the TOCTOU that a read-then-write would allow). Each
 * physical request consumes exactly one attempt slot; when the slots are
 * gone the row is deleted and every further guess is rejected.
 */
export async function verifyOtp(email: string, code: string): Promise<OtpResult> {
  await connectMongo();
  const normalized = normalizeEmail(email);
  const max = env.server.OTP_MAX_ATTEMPTS;

  // Atomically claim one attempt: match only while under the cap AND not
  // expired, and increment in the same operation. Returns the POST-increment
  // doc, or null when no such row exists (missing / expired / cap reached).
  const claimed = await AdminOtp.findOneAndUpdate(
    {
      email: normalized,
      attempts: { $lt: max },
      expiresAt: { $gt: new Date() },
    },
    { $inc: { attempts: 1 } },
    { new: true },
  ).lean<AdminOtpDoc | null>();

  if (!claimed) {
    // Distinguish "expired/too many" from "never existed" for a better
    // message, without granting another guess. A row that exists but is
    // expired or capped is swept here.
    const stale = await AdminOtp.findOne({ email: normalized }).lean<AdminOtpDoc | null>();
    if (!stale) return "invalid";
    const expired = stale.expiresAt.getTime() < Date.now();
    await AdminOtp.deleteOne({ _id: stale._id });
    return expired ? "expired" : "too_many_attempts";
  }

  const match = safeEqual(claimed.codeHash, hashCode(normalized, code));
  if (!match) {
    // Wrong guess. If that was the last slot, consume the row now so it
    // can't be re-read; otherwise leave it for the remaining attempts.
    if (claimed.attempts >= max) {
      await AdminOtp.deleteOne({ _id: claimed._id });
      return "too_many_attempts";
    }
    return "invalid";
  }

  // Correct — consume it (single-use).
  await AdminOtp.deleteOne({ _id: claimed._id });
  return "ok";
}
