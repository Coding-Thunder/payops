import { NextResponse } from "next/server";

import { clientIp as resolveClientIp } from "@/server/api/client-ip";

/**
 * HTTP helpers for the console's route handlers.
 *
 * This file used to carry its own copies of `jsonOk`/`jsonError`/`clientIp`.
 * They have been collapsed onto the main app's canonical implementations,
 * because the copies had silently drifted in two ways that mattered:
 *
 *  - `jsonError` took `(status, message, code)` while the root takes
 *    `(status, code, message)`. Both params are `string`, so nothing caught a
 *    mix-up; the console's error bodies had `code:"ERROR"` and the real code
 *    sitting in `message`.
 *  - `clientIp` trusted the FIRST `X-Forwarded-For` hop, which the client
 *    fully controls. Behind Cloudflare that let an attacker rotate the header
 *    to mint a fresh rate-limit bucket per request. The root version prefers
 *    `CF-Connecting-IP` (which the edge overwrites) and was hardened for
 *    exactly this reason.
 */
export { jsonOk, jsonError } from "@/server/api/respond";

/**
 * Resolve the real client IP. Delegates to the hardened root resolver; the
 * signature difference (Request vs Headers) is absorbed here so console call
 * sites keep passing the request.
 */
export function clientIp(req: Request): string | null {
  return resolveClientIp(req.headers);
}

/**
 * A single CSV cell, hardened against spreadsheet formula injection. Cross-
 * tenant customer/order data is untrusted: a value like `=cmd|...` opened in
 * Excel/Sheets would execute. We prefix any cell starting with a formula
 * trigger (`= + - @` / tab / CR) with a `'` so it's treated as text, then
 * apply standard quote-escaping. Arrays are joined with `|`.
 */
export function csvCell(v: unknown): string {
  let s = Array.isArray(v) ? v.join("|") : v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * CSRF defense for state-changing requests. The admin session cookie is
 * already SameSite=strict (the primary guard); this is defense-in-depth:
 * on a mutating method, if the browser sent an `Origin`, its host MUST
 * match the request host. A missing Origin is allowed (some legitimate
 * same-origin POSTs omit it, and SameSite=strict still covers them); an
 * Origin that doesn't match is refused.
 *
 * Deliberately NOT the root's `enforceSameOrigin`: that one throws an
 * AppError for the `withApi` wrapper to catch, and rejects a missing Origin
 * outright. Console handlers return responses directly and must keep the
 * permissive-on-absent behaviour they were written against.
 *
 * Returns an error response to short-circuit with, or null to proceed.
 */
export function assertSameOrigin(req: Request): NextResponse | null {
  const method = (req.method || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return null;

  const origin = req.headers.get("origin");
  if (!origin) return null;

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "CSRF", message: "Malformed Origin header" } },
      { status: 403 },
    );
  }

  const hosts = [
    req.headers.get("host"),
    req.headers.get("x-forwarded-host"),
  ].filter((h): h is string => Boolean(h));

  if (hosts.some((h) => h === originHost)) return null;
  return NextResponse.json(
    { ok: false, error: { code: "CSRF", message: "Cross-origin request refused" } },
    { status: 403 },
  );
}
