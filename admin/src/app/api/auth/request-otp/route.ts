import type { NextRequest } from "next/server";
import { z } from "zod";

import { isAllowedEmail, normalizeEmail } from "@/server/auth/allowlist";
import { issueOtp } from "@/server/auth/otp";
import { sendOtpEmail } from "@/server/email/mailer";
import { jsonError, jsonOk, clientIp } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ email: z.string().email() });

/**
 * Email path, step 1: request an OTP. Enumeration-safe — always responds
 * "sent" whether or not the email is allow-listed; only allow-listed
 * addresses actually receive a code.
 */
export async function POST(req: NextRequest) {
  const ip = clientIp(req) ?? "unknown";
  const body = await req.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) return jsonError(422, "A valid email is required");

  const email = normalizeEmail(parsed.data.email);
  // Two caps: per-(ip,email) AND per-email-alone. The per-email cap is
  // independent of client IP, so spoofing X-Forwarded-For can't be used to
  // email-bomb an allow-listed admin.
  if (
    !rateLimit(`otp-req:${ip}:${email}`, 5, 10 * 60_000) ||
    !rateLimit(`otp-req-email:${email}`, 5, 10 * 60_000)
  ) {
    return jsonError(429, "Too many requests. Try again in a few minutes.");
  }

  if (isAllowedEmail(email)) {
    // Fire-and-forget: the DB + SMTP work must NOT be on the response path,
    // otherwise an allow-listed email responds measurably slower than a
    // non-allow-listed one — a timing oracle that leaks the allow-list.
    void (async () => {
      try {
        const code = await issueOtp(email);
        await sendOtpEmail(email, code);
      } catch (err) {
        // Server-side log ONLY — never surfaced to the client, so the
        // endpoint stays enumeration-safe and the response/timing below is
        // unchanged. Without this, the real cause of a missing OTP (Mongo
        // unreachable, SMTP creds, an unverified From address) is
        // completely invisible in the deploy logs.
        console.error(
          `[admin] OTP issue/send failed for ${email}:`,
          err instanceof Error ? (err.stack ?? err.message) : err,
        );
      }
    })();
  } else {
    // Also server-side only; the response is identical either way.
    console.warn(`[admin] OTP requested for non-allow-listed email: ${email}`);
  }
  return jsonOk({ sent: true });
}
