import type { NextRequest } from "next/server";
import { z } from "zod";

import { isAllowedEmail, normalizeEmail } from "@/server/auth/allowlist";
import { verifyOtp } from "@/server/auth/otp";
import { setAdminCookie, signAdminSession } from "@/server/auth/session";
import { recordAdminAction } from "@/server/audit";
import { jsonError, jsonOk, clientIp } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  email: z.string().email(),
  code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code"),
});

/**
 * Step 2 (both paths): verify the OTP and, on success, mint the admin
 * session cookie. The allow-list is re-checked here so a session can never
 * be issued for a non-allow-listed email even if an OTP row somehow existed.
 */
export async function POST(req: NextRequest) {
  const ip = clientIp(req) ?? "unknown";
  const body = await req.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) return jsonError(422, "Enter your email and the 6-digit code");

  const email = normalizeEmail(parsed.data.email);
  // Per-(ip,email) + per-email caps. The atomic OTP attempt cap in
  // verifyOtp is the primary brute-force defense; these bound request
  // volume regardless of a spoofed client IP.
  if (
    !rateLimit(`otp-verify:${ip}:${email}`, 10, 10 * 60_000) ||
    !rateLimit(`otp-verify-email:${email}`, 30, 10 * 60_000)
  ) {
    return jsonError(429, "Too many attempts. Request a new code.");
  }
  if (!isAllowedEmail(email)) {
    return jsonError(400, "Invalid or expired code.");
  }

  const result = await verifyOtp(email, parsed.data.code);
  if (result !== "ok") {
    const message =
      result === "too_many_attempts"
        ? "Too many attempts. Request a new code."
        : result === "expired"
          ? "That code has expired. Request a new one."
          : "Invalid or expired code.";
    return jsonError(400, message);
  }

  const token = await signAdminSession(email);
  await setAdminCookie(token);
  await recordAdminAction({
    action: "auth.login",
    actorEmail: email,
    targetType: "session",
    ip,
  });
  return jsonOk({ ok: true });
}
