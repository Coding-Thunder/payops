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
  // Both sources are stripped of ALL whitespace, not just the ends. These two
  // used to disagree — RESEND_API_KEY got `.trim()` while SMTP_PASS got
  // `replace(/\s+/g, "")` — so a key pasted into a hosting dashboard with a
  // line break or a stray space *inside* it survived cleaning and produced an
  // opaque `401 validation_error / API key is invalid` from Resend. An API
  // key never legitimately contains whitespace, so strip it everywhere.
  const explicit = env.server.RESEND_API_KEY?.replace(/\s+/g, "");
  if (explicit) return explicit;
  const smtp = env.server.SMTP_PASS?.replace(/\s+/g, "");
  if (smtp?.startsWith("re_")) return smtp;
  return null;
}

export type ResendKeyStatus = "ok" | "invalid" | "unconfigured" | "unknown";

/**
 * Which env var supplied the key. The NAME only — never the value. Reported by
 * `/api/health` so an operator can tell a stale `RESEND_API_KEY` shadowing a
 * good `SMTP_PASS` (the precedence in `resendApiKey`) from a missing key,
 * without shell access to the running container.
 */
export function resendKeySource(): "RESEND_API_KEY" | "SMTP_PASS" | "none" {
  if (env.server.RESEND_API_KEY?.replace(/\s+/g, "")) return "RESEND_API_KEY";
  const smtp = env.server.SMTP_PASS?.replace(/\s+/g, "");
  if (smtp?.startsWith("re_")) return "SMTP_PASS";
  return "none";
}

export interface ResendKeyProbe {
  status: ResendKeyStatus;
  source: "RESEND_API_KEY" | "SMTP_PASS" | "none";
  /** HTTP status from `GET /domains`; null when no request was made. */
  httpStatus: number | null;
  /** Transport-level failure (timeout/DNS). Never carries a credential. */
  error: string | null;
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
 *
 * `httpStatus` is returned alongside because "ok" and "unknown" were
 * indistinguishable in the probe payload: a probe that times out and a probe
 * that succeeds both left `/api/health` reporting no warning, which is how a
 * console-login outage ran under a green health check.
 *
 * NOTE: this probes a READ endpoint. A key can pass `GET /domains` and still
 * be refused by `POST /emails`, so a green probe is evidence, not proof, that
 * mail will send.
 */
export async function resendKeyProbe(): Promise<ResendKeyProbe> {
  const source = resendKeySource();
  const key = resendApiKey();
  if (!key) {
    return { status: "unconfigured", source, httpStatus: null, error: null };
  }
  try {
    const res = await fetch("https://api.resend.com/domains", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5_000),
    });
    const status: ResendKeyStatus =
      res.status === 401 || res.status === 403
        ? "invalid"
        : res.ok
          ? "ok"
          : "unknown";
    return { status, source, httpStatus: res.status, error: null };
  } catch (err) {
    return {
      status: "unknown",
      source,
      httpStatus: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function resendKeyStatus(): Promise<ResendKeyStatus> {
  return (await resendKeyProbe()).status;
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
