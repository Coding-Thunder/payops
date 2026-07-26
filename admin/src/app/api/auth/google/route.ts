import type { NextRequest } from "next/server";
import { z } from "zod";

import { isAllowedEmail } from "@/server/auth/allowlist";
import { verifyGoogleIdToken } from "@/server/auth/firebase-admin";
import { issueOtp } from "@/server/auth/otp";
import { sendOtpEmail } from "@/server/email/mailer";
import { assertSameOrigin, jsonError, jsonOk, clientIp } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";

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
    return jsonError(429, "Too many requests. Try again shortly.");
  }

  const body = await req.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) return jsonError(422, "Missing Google token");

  let email: string;
  try {
    email = await verifyGoogleIdToken(parsed.data.idToken);
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode ?? 401;
    if (status === 503) {
      return jsonError(503, "Google sign-in is not configured on the server.");
    }
    return jsonError(401, "Could not verify your Google sign-in.");
  }

  if (!isAllowedEmail(email)) {
    return jsonError(403, "This Google account is not authorized for admin access.");
  }

  // Per-email issuance cap (shared key with the email path) so the Google
  // route can't be used to bypass the OTP-bombing limit.
  if (!rateLimit(`otp-req-email:${email}`, 5, 10 * 60_000)) {
    return jsonError(429, "Too many requests. Try again in a few minutes.");
  }

  const code = await issueOtp(email);
  try {
    await sendOtpEmail(email, code);
  } catch {
    // ignore delivery errors
  }
  // Safe to echo the verified, allow-listed email so the client can drive
  // the OTP step without re-typing it.
  return jsonOk({ sent: true, email });
}
