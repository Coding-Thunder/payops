import "server-only";

import { env } from "@/lib/env";

/**
 * Preferred email transport: Resend's HTTPS API.
 *
 * Why not SMTP: outbound SMTP (465/587) is throttled or blocked by many cloud
 * platforms (DigitalOcean App Platform included), so nodemailer hangs on
 * connect and the HTTP request times out (504) with nothing delivered. The
 * Resend HTTP API runs over 443 (never blocked), returns a real per-message
 * id or a typed error, and fails fast.
 *
 * The key is the same `re_…` value already used as the SMTP password, so no
 * new secret is needed in prod — RESEND_API_KEY is honoured first, otherwise
 * SMTP_PASS is used when it looks like a Resend key.
 */
export function resendApiKey(): string | null {
  const explicit = env.server.RESEND_API_KEY?.trim();
  if (explicit) return explicit;
  const smtp = env.server.SMTP_PASS?.replace(/\s+/g, "");
  if (smtp && smtp.startsWith("re_")) return smtp;
  return null;
}

/**
 * Liveness check for the Resend credential, for `/api/health`. A REJECTED key
 * is the exact failure that silently killed every payment-request email (all
 * orders stalled at LINK_GENERATED with a 401 from Resend), so we surface it
 * proactively instead of on the next customer send. Uses a cheap read-only
 * `GET /domains` with a 5s cap; never throws.
 *   "ok"           key present and accepted (2xx)
 *   "invalid"      key present but rejected (401/403) — the actionable one
 *   "unconfigured" no re_ key set (SMTP-only / dev)
 *   "unknown"      network error or non-auth status — don't cry wolf
 */
export async function resendKeyStatus(): Promise<
  "ok" | "invalid" | "unconfigured" | "unknown"
> {
  const key = resendApiKey();
  if (!key) return "unconfigured";
  try {
    const res = await fetch("https://api.resend.com/domains", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (res.status === 401 || res.status === 403) return "invalid";
    return res.ok ? "ok" : "unknown";
  } catch {
    return "unknown";
  }
}

export interface ResendSendPayload {
  from: string;
  to: string;
  replyTo?: string | null;
  subject: string;
  html: string;
  text?: string;
  /** X-Entity-Kind header value for classification/analytics. */
  kind: string;
  /** Additional headers merged alongside X-Entity-Kind. */
  headers?: Record<string, string>;
}

/**
 * Deliver one email via Resend's HTTP API. Resolves to the message id on a
 * 2xx; throws on a non-2xx (with `responseCode`/`response` attached so the
 * caller's error classifier can categorise it) or on a network/timeout error.
 * A 10s AbortSignal guarantees this can never hang the request.
 */
export async function deliverViaResend(
  apiKey: string,
  payload: ResendSendPayload,
): Promise<{ id: string | null }> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: payload.from,
      to: payload.to,
      subject: payload.subject,
      html: payload.html,
      text: payload.text,
      reply_to: payload.replyTo || undefined,
      headers: { "X-Entity-Kind": payload.kind, ...(payload.headers ?? {}) },
    }),
    // Fail fast — a hung transport must never block the HTTP request.
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // Shape the error like a nodemailer error so classifyMailError can read
    // responseCode/response and produce an actionable message.
    throw Object.assign(
      new Error(`Resend API ${res.status}: ${body.slice(0, 300)}`),
      { responseCode: res.status, response: body },
    );
  }

  const data = (await res.json().catch(() => ({}))) as { id?: string };
  return { id: data.id ?? null };
}
