import "server-only";

/**
 * Resolve the real client IP from request headers, for rate-limiting + audit.
 *
 * Prefer `CF-Connecting-IP`: Cloudflare (our production edge) sets it to the
 * true client IP and OVERWRITES any client-supplied value, so it cannot be
 * spoofed. The previous code trusted the FIRST `X-Forwarded-For` hop — which
 * the client fully controls — letting an attacker rotate it to mint a fresh
 * per-IP bucket on every request and walk straight past the auth/reset rate
 * limiter. Fall back to `x-real-ip` (set by the trusted proxy), then the first
 * XFF hop only when no trusted-proxy header is present (local/direct hits,
 * where there's no better signal and spoofing is moot).
 *
 * Accepts anything with a header `get()` — both `Headers` and Next's
 * `ReadonlyHeaders`.
 */
export function clientIp(h: { get(name: string): string | null }): string | null {
  const cf = h.get("cf-connecting-ip")?.trim();
  if (cf) return cf;
  const real = h.get("x-real-ip")?.trim();
  if (real) return real;
  const first = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  return first || null;
}
