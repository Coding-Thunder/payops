import "server-only";

import { headers } from "next/headers";

import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";

/* ─────────────────────────────── Origin check ───────────────────────────── */

/**
 * Reject state-changing cross-origin requests. Pairs with
 * `sameSite=strict` cookie + Content-Type=application/json as the
 * three-layer CSRF defense.
 *
 * Webhook routes don't call this — they're gateway-signature-authed
 * and originate from the gateway, not the browser. The `withApi`
 * wrapper accepts an `allowCrossOrigin` opt-out for any future route
 * that needs it.
 */
export async function enforceSameOrigin(): Promise<void> {
  // Test harness drives handlers without going through a real browser,
  // so the Origin header is rarely set. Skip the guard there — same
  // contract as `enforceRateLimit`. Production still enforces.
  if (process.env.PAYOPS_TEST_MODE) return;
  const h = await headers();
  const origin = h.get("origin");
  const referer = h.get("referer");
  if (!origin && !referer) {
    throw new AppError(
      "FORBIDDEN",
      "Cross-origin request blocked: missing Origin/Referer",
      403,
    );
  }
  const allowed = normalize(env.server.APP_URL);
  const candidate = origin ?? referer ?? "";
  if (!candidate || normalize(candidate) !== allowed) {
    throw new AppError("FORBIDDEN", "Cross-origin request blocked", 403);
  }
}

function normalize(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "";
  }
}

/* ───────────────────────────── Body-size cap ────────────────────────────── */

/** Default request body cap for JSON endpoints. Drafts may opt upward;
 *  the webhook route caps separately (64 KB) before signature verify. */
export const DEFAULT_BODY_LIMIT_BYTES = 32 * 1024;

/**
 * Reject requests with Content-Length above the cap. Cheap pre-flight —
 * pair with bounded reads in routes that don't trust Content-Length.
 */
export async function enforceBodyLimit(
  contentLength: string | null,
  maxBytes = DEFAULT_BODY_LIMIT_BYTES,
): Promise<void> {
  if (!contentLength) return;
  const n = Number.parseInt(contentLength, 10);
  if (Number.isFinite(n) && n > maxBytes) {
    throw new AppError(
      "BAD_REQUEST",
      `Request body too large (${n} > ${maxBytes} bytes)`,
      413,
    );
  }
}

/* ───────────────────────────── Rate limiter ─────────────────────────────── */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
let lastSweepAt = 0;

interface RateLimitOptions {
  /** Logical route name — namespace for the bucket. */
  route: string;
  /** Caller key (user id, IP, tokenHash, etc.). */
  key: string;
  /** Max requests within the window. */
  max: number;
  /** Window length in ms. */
  windowMs: number;
}

/**
 * In-process token bucket. Single-instance only — that's intentional
 * for the $5 tier. Same signature carries over when you swap the Map
 * for a Redis store later. Throws RATE_LIMITED (429) on excess.
 */
export function enforceRateLimit(opts: RateLimitOptions): void {
  // Tests rely on tight loops that would trip prod-sized limits.
  if (process.env.PAYOPS_TEST_MODE) return;

  const now = Date.now();
  maybeSweep(now);
  const bucketKey = `${opts.route}:${opts.key}`;
  const existing = buckets.get(bucketKey);
  if (!existing || existing.resetAt <= now) {
    buckets.set(bucketKey, { count: 1, resetAt: now + opts.windowMs });
    return;
  }
  if (existing.count >= opts.max) {
    const retryAfterSec = Math.max(
      1,
      Math.ceil((existing.resetAt - now) / 1000),
    );
    throw new AppError(
      "RATE_LIMITED",
      "Too many requests — please try again shortly",
      429,
      { details: { retryAfterSec } },
    );
  }
  existing.count += 1;
}

/** Test-only: reset all buckets. */
export function _resetRateLimitsForTests(): void {
  buckets.clear();
  lastSweepAt = 0;
}

function maybeSweep(now: number): void {
  if (now - lastSweepAt < 60_000) return;
  lastSweepAt = now;
  for (const [k, b] of buckets.entries()) {
    if (b.resetAt <= now) buckets.delete(k);
  }
}

/* ─────────────────────────── PDF render semaphore ───────────────────────── */

/**
 * Hard cap on concurrent PDF renders. `@react-pdf/renderer` peaks at
 * 200-500 MB heap per render; on a $5 single-instance, one concurrent
 * render is the safe ceiling. Excess callers get 503 + Retry-After so
 * the UI can back off rather than OOM the box.
 */
const PDF_MAX_CONCURRENT = 1;
let pdfActive = 0;

export function acquirePdfSlot(): boolean {
  if (pdfActive >= PDF_MAX_CONCURRENT) return false;
  pdfActive += 1;
  return true;
}

export function releasePdfSlot(): void {
  pdfActive = Math.max(0, pdfActive - 1);
}

/** Hard cap on events per single PDF render. */
export const PDF_MAX_EVENTS = 200;

/* ─────────────────────────── SSE connection caps ────────────────────────── */

const PER_USER_SSE_CAP = 3;
const TOTAL_SSE_CAP = 100;
const sseByUser = new Map<string, number>();
let sseTotal = 0;

export type SseAcquireResult =
  | { ok: true }
  | { ok: false; reason: "per_user" | "global" };

export function acquireSseSlot(userId: string): SseAcquireResult {
  if (sseTotal >= TOTAL_SSE_CAP) return { ok: false, reason: "global" };
  const perUser = sseByUser.get(userId) ?? 0;
  if (perUser >= PER_USER_SSE_CAP) return { ok: false, reason: "per_user" };
  sseByUser.set(userId, perUser + 1);
  sseTotal += 1;
  return { ok: true };
}

export function releaseSseSlot(userId: string): void {
  const perUser = sseByUser.get(userId) ?? 0;
  if (perUser <= 1) sseByUser.delete(userId);
  else sseByUser.set(userId, perUser - 1);
  sseTotal = Math.max(0, sseTotal - 1);
}

/* ──────────────────────────── Response headers ──────────────────────────── */

/** Apply HSTS + private-cache headers to every JSON response. HSTS is
 *  harmless over HTTP (browsers ignore); enforced by browsers once HTTPS
 *  is seen. `Cache-Control: no-store, private` blocks upstream proxies
 *  from caching authed JSON — non-overriding so callers can still opt
 *  into long-cache for genuinely public assets. */
export function applySecurityHeaders(res: Response): void {
  res.headers.set(
    "Strict-Transport-Security",
    "max-age=31536000; includeSubDomains",
  );
  if (!res.headers.has("Cache-Control")) {
    res.headers.set("Cache-Control", "no-store, private");
  }
}
