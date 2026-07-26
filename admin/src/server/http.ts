import { NextResponse } from "next/server";

export function jsonOk<T>(data: T): NextResponse {
  return NextResponse.json({ ok: true, data });
}

export function jsonError(
  status: number,
  message: string,
  code = "ERROR",
): NextResponse {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
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

export function clientIp(req: Request): string | null {
  const h = req.headers;
  return (
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    h.get("x-real-ip") ||
    null
  );
}

/**
 * CSRF defense for state-changing requests. The admin session cookie is
 * already SameSite=strict (the primary guard); this is defense-in-depth:
 * on a mutating method, if the browser sent an `Origin`, its host MUST
 * match the request host. A missing Origin is allowed (some legitimate
 * same-origin POSTs omit it, and SameSite=strict still covers them); an
 * Origin that doesn't match is refused.
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
    return jsonError(403, "Malformed Origin header", "CSRF");
  }

  const hosts = [
    req.headers.get("host"),
    req.headers.get("x-forwarded-host"),
  ].filter((h): h is string => Boolean(h));

  if (hosts.some((h) => h === originHost)) return null;
  return jsonError(403, "Cross-origin request refused", "CSRF");
}
