/**
 * Fixed-window rate limiter for the console's auth endpoints.
 *
 * Keys are attacker-supplied (`otp-req-email:<email>`, `google:<ip>`), so the
 * bucket map MUST be swept — the previous version never removed expired
 * entries, which let anyone grow it without bound by posting a fresh email on
 * every request. The root app's limiter (`src/server/api/security.ts`) already
 * solved this with a periodic sweep; the same approach is used here rather
 * than reusing that function directly, because the root's variant throws an
 * `AppError` for the `withApi` wrapper to catch, while console handlers need
 * a boolean they can turn into their own response.
 *
 * Still single-instance and in-process. That is adequate: the OTP attempt cap
 * in `auth/otp.ts` is the real brute-force defense and it is enforced
 * atomically in Mongo, so a second app instance cannot bypass it.
 */
interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/** Sweep at most this often, regardless of traffic. */
const SWEEP_INTERVAL_MS = 60_000;
/** Hard ceiling: if the map still grows past this, evict the oldest entries. */
const MAX_BUCKETS = 10_000;

let lastSweep = 0;

function sweep(now: number): void {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [key, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(key);
  }
  // A burst of unique keys inside one window can still outrun the sweep.
  // Evict oldest-expiring first so live limits survive.
  if (buckets.size > MAX_BUCKETS) {
    const excess = buckets.size - MAX_BUCKETS;
    const oldest = [...buckets.entries()]
      .sort((a, b) => a[1].resetAt - b[1].resetAt)
      .slice(0, excess);
    for (const [key] of oldest) buckets.delete(key);
  }
}

export function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  sweep(now);
  const b = buckets.get(key);
  if (!b || b.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (b.count >= max) return false;
  b.count += 1;
  return true;
}

/** Test-only introspection/reset. */
export function _rateLimitStateForTests(): { size: number } {
  return { size: buckets.size };
}
export function _resetRateLimitForTests(): void {
  buckets.clear();
  lastSweep = 0;
}
