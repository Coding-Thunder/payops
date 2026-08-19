import type { NextRequest } from "next/server";
import { z } from "zod";

import { isAllowedEmail, normalizeEmail } from "@/console/server/auth/allowlist";
import { issueOtp } from "@/console/server/auth/otp";
import { sendOtpEmail } from "@/console/server/email/mailer";
import { assertSameOrigin, jsonError, jsonOk, clientIp } from "@/console/server/http";
import { rateLimit } from "@/console/server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ email: z.string().email() });

/**
 * Hard ceiling on the issue+send round trip. Below the console's own
 * nodemailer socket timeout so a wedged relay surfaces here as a typed 502
 * rather than hanging until the ingress gives up.
 */
const SEND_TIMEOUT_MS = 12_000;

/**
 * Every response is padded to at least this long. `isAllowedEmail` now always
 * hits Mongo, so the old "bootstrap short-circuits before any DB I/O" oracle
 * is gone — but a real send still takes materially longer than a rejection,
 * and that difference alone would leak who is an admin. The floor collapses
 * both paths onto the same wall-clock.
 */
const RESPONSE_FLOOR_MS = 700;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Email path, step 1: request an OTP.
 *
 * Enumeration-safe: an address that is not an active admin gets the same
 * response, and the same latency, as one that is.
 *
 * Delivery-honest: the send is AWAITED. It used to be fire-and-forget, so a
 * misconfigured or failing relay produced `{ sent: true }`, the UI advanced
 * to the code step, and nobody could sign in — with the only trace a line in
 * the runtime log. A transport failure is now a 502.
 */
export async function POST(req: NextRequest) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;

  const startedAt = Date.now();
  const ip = clientIp(req) ?? "unknown";
  const body = await req.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return jsonError(422, "VALIDATION_ERROR", "A valid email is required");
  }

  const email = normalizeEmail(parsed.data.email);
  // Two caps: per-(ip,email) AND per-email-alone. The per-email cap is
  // independent of client IP, so a spoofed X-Forwarded-For can't be used to
  // email-bomb an admin.
  if (
    !rateLimit(`otp-req:${ip}:${email}`, 5, 10 * 60_000) ||
    !rateLimit(`otp-req-email:${email}`, 5, 10 * 60_000)
  ) {
    return jsonError(
      429,
      "RATE_LIMITED",
      "Too many requests. Try again in a few minutes.",
    );
  }

  let deliveryFailed = false;
  if (await isAllowedEmail(email)) {
    try {
      await withTimeout(
        (async () => {
          const code = await issueOtp(email);
          await sendOtpEmail(email, code);
        })(),
        SEND_TIMEOUT_MS,
      );
    } catch (err) {
      deliveryFailed = true;
      // Diagnostics only — never the code, never the recipient's token.
      console.error(
        `[admin] OTP delivery failed for ${email}:`,
        err instanceof Error ? (err.stack ?? err.message) : err,
      );
    }
  } else {
    console.warn(`[admin] OTP requested for non-admin email: ${email}`);
  }

  const elapsed = Date.now() - startedAt;
  if (elapsed < RESPONSE_FLOOR_MS) await sleep(RESPONSE_FLOOR_MS - elapsed);

  if (deliveryFailed) {
    return jsonError(
      502,
      "EMAIL_DELIVERY_FAILED",
      "We couldn't send your sign-in code. Please try again, and tell an administrator if it keeps failing.",
    );
  }
  return jsonOk({ sent: true });
}
