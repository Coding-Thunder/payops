import type { NextRequest } from "next/server";
import { z } from "zod";

import { isAllowedEmail } from "@/console/server/auth/allowlist";
import { verifyGoogleIdToken } from "@/console/server/auth/firebase-admin";
import { issueOtp } from "@/console/server/auth/otp";
import { sendOtpEmail } from "@/console/server/email/mailer";
import { assertSameOrigin, jsonError, jsonOk, clientIp } from "@/console/server/http";
import { rateLimit } from "@/console/server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ idToken: z.string().min(20) });

/**
 * Google path, step 1: verify the Firebase ID token, extract the verified
 * email, and — only if it's allow-listed — issue an OTP. The user still
 * must verify the OTP before a session is granted.
 */
export async function POST(req: NextRequest) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;

  const ip = clientIp(req) ?? "unknown";
  if (!rateLimit(`google:${ip}`, 10, 10 * 60_000)) {
    return jsonError(429, "RATE_LIMITED", "Too many requests. Try again shortly.");
  }

  const body = await req.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) return jsonError(422, "VALIDATION_ERROR", "Missing Google token");

  let email: string;
  try {
    email = await verifyGoogleIdToken(parsed.data.idToken);
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode ?? 401;
    if (status === 503) {
      return jsonError(503, "SERVICE_UNAVAILABLE", "Google sign-in is not configured on the server.");
    }
    return jsonError(401, "UNAUTHORIZED", "Could not verify your Google sign-in.");
  }

  if (!(await isAllowedEmail(email))) {
    return jsonError(403, "FORBIDDEN", "This Google account is not authorized for admin access.");
  }

  // Per-email issuance cap (shared key with the email path) so the Google
  // route can't be used to bypass the OTP-bombing limit.
  if (!rateLimit(`otp-req-email:${email}`, 5, 10 * 60_000)) {
    return jsonError(429, "RATE_LIMITED", "Too many requests. Try again in a few minutes.");
  }

  const code = await issueOtp(email);
  try {
    await sendOtpEmail(email, code);
  } catch (err) {
    // Was `catch {}`. Swallowing here told the client to go enter a code that
    // was never delivered. The identity is already verified at this point, so
    // there is no enumeration concern in reporting the real outcome.
    console.error(
      `[admin] OTP delivery failed for ${email}:`,
      err instanceof Error ? (err.stack ?? err.message) : err,
    );
    return jsonError(
      502,
      "EMAIL_DELIVERY_FAILED",
      "Signed in with Google, but we couldn't send your sign-in code. Please try again.",
    );
  }
  // Safe to echo the verified, allow-listed email so the client can drive
  // the OTP step without re-typing it.
  return jsonOk({ sent: true, email });
}
