import "server-only";

import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";

/**
 * Cloudflare Turnstile siteverify endpoint. Public, no auth, the
 * (token, secret, ip) tuple is the credential.
 */
const TURNSTILE_VERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Hard timeout on the verifier, Cloudflare's edge is usually <200ms
 *  but we don't want a slow upstream wedging the login path. */
const VERIFY_TIMEOUT_MS = 3_000;

interface SiteVerifyResponse {
  success: boolean;
  challenge_ts?: string;
  hostname?: string;
  "error-codes"?: string[];
  action?: string;
  cdata?: string;
}

export interface TurnstileContext {
  /** Token submitted by the browser widget (the `cf-turnstile-response`
   *  hidden input rendered by the official script). */
  token?: string | null;
  /** Caller IP. Cloudflare uses it as a soft signal but the verify
   *  still works with `null`. */
  remoteIp?: string | null;
}

/**
 * Verify a Turnstile token. When `TURNSTILE_SECRET_KEY` is unset the
 * verifier no-ops and returns silently, that's the local-dev /
 * not-yet-configured contract. When the secret IS set, a missing or
 * invalid token raises a 403 `BOT_CHECK_FAILED` AppError.
 *
 * The route handler should call this BEFORE any DB work so we don't
 * burn cycles on a request that's about to be rejected anyway.
 */
export async function verifyTurnstile(
  ctx: TurnstileContext,
): Promise<void> {
  const secret = env.server.TURNSTILE_SECRET_KEY?.trim();
  if (!secret) return; // disabled
  const token = ctx.token?.trim();
  if (!token) {
    throw new AppError(
      "BOT_CHECK_FAILED",
      "Captcha required, please complete the verification challenge.",
      403,
    );
  }

  const form = new URLSearchParams();
  form.set("secret", secret);
  form.set("response", token);
  if (ctx.remoteIp) form.set("remoteip", ctx.remoteIp);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);

  let body: SiteVerifyResponse;
  try {
    const res = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: controller.signal,
    });
    body = (await res.json()) as SiteVerifyResponse;
  } catch (err) {
    // Fail closed on verifier timeout / network error. Better to refuse
    // the login than to silently drop the bot-check.
    logger.warn("turnstile.verify_request_failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    throw new AppError(
      "BOT_CHECK_FAILED",
      "Could not verify the captcha, please try again.",
      503,
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!body.success) {
    logger.warn("turnstile.verify_rejected", {
      codes: body["error-codes"],
    });
    throw new AppError(
      "BOT_CHECK_FAILED",
      "Captcha verification failed, please retry.",
      403,
    );
  }
}

/** Whether the public site key is configured. Drives the client widget. */
export function turnstileSiteKey(): string | null {
  return env.public.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim() || null;
}
