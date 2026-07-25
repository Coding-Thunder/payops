/**
 * Tiny in-process fixed-window rate limiter. Adequate for a single-instance
 * admin console (the OTP endpoints are the only things worth throttling).
 * Not shared across instances — scale the admin component to 1 instance,
 * or swap for a Mongo/Redis limiter if you ever run more.
 */
const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (b.count >= max) return false;
  b.count += 1;
  return true;
}
