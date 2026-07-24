import "server-only";

import nodemailer, { type Transporter } from "nodemailer";

import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

let cached: Transporter | null = null;
let verifyPromise: Promise<void> | null = null;

/**
 * Returns a singleton Nodemailer transporter wired to Google Workspace SMTP
 * (or any SMTP host configured via env). Returns `null` when SMTP isn't
 * configured - callers should treat that as "email disabled" rather than an
 * error so the rest of the order flow keeps working.
 */
export function getMailer(): Transporter | null {
  const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS } =
    env.server;

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    return null;
  }

  if (cached) return cached;

  cached = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE, // true => SMTPS (465), false => STARTTLS (587)
    auth: {
      user: SMTP_USER,
      // Google App Passwords are displayed with spaces ("abcd efgh ijkl mnop")
      // but SMTP auth doesn't accept them - strip whitespace defensively.
      pass: SMTP_PASS.replace(/\s+/g, ""),
    },
    pool: true,
    maxConnections: 3,
    maxMessages: 100,
    connectionTimeout: 10_000,
    socketTimeout: 20_000,
  });

  return cached;
}

export type MailFailureCategory =
  | "auth"
  | "connection"
  | "throttled"
  | "recipient"
  | "message"
  | "unknown";

interface MailErrorLike {
  code?: unknown;
  responseCode?: unknown;
  response?: unknown;
  command?: unknown;
  message?: unknown;
}

/** Transport-level (socket/TLS/DNS) failure codes Nodemailer surfaces on
 *  `err.code`. These mean "we never reached the relay", distinct from the
 *  relay accepting the connection then rejecting the message. */
const CONNECTION_CODES = new Set([
  "ECONNECTION",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ESOCKET",
  "ETLS",
  "EDNS",
  "ENOTFOUND",
  "EHOSTUNREACH",
]);

/**
 * Classify a Nodemailer send failure into an operator-actionable category
 * + message. The message is safe to show a signed-in operator: it never
 * echoes the raw SMTP response (which can carry provider internals or the
 * recipient address) — that stays in the logs. Pure + dependency-free so
 * it unit-tests without a live relay.
 *
 * Ordering note: providers often encode *throttling* as a 5xx with quota
 * text (Gmail's "550 Daily user sending limit exceeded"), so the text
 * signal is checked before the numeric-code buckets — otherwise a quota
 * bounce would be misread as a bad recipient.
 */
export function classifyMailError(err: unknown): {
  category: MailFailureCategory;
  message: string;
} {
  const e = (err ?? {}) as MailErrorLike;
  const code = typeof e.code === "string" ? e.code.toUpperCase() : "";
  const responseCode =
    typeof e.responseCode === "number" ? e.responseCode : undefined;
  const command = typeof e.command === "string" ? e.command.toUpperCase() : "";
  const text = `${typeof e.response === "string" ? e.response : ""} ${
    typeof e.message === "string" ? e.message : ""
  }`.toLowerCase();

  const looksThrottled =
    /quota|sending limit|rate.?limit|too many (messages|emails|recipients)|try again later|throttl|temporarily (deferred|rejected)/.test(
      text,
    );

  if (looksThrottled) {
    return {
      category: "throttled",
      message:
        "Your mail provider is temporarily throttling sends (rate limit or daily quota). Wait a few minutes, then try again.",
    };
  }
  if (
    code === "EAUTH" ||
    responseCode === 530 ||
    responseCode === 534 ||
    responseCode === 535
  ) {
    return {
      category: "auth",
      message:
        "The mail account rejected our sign-in. Check the SMTP username and app password in your email settings, then try again.",
    };
  }
  if (CONNECTION_CODES.has(code)) {
    return {
      category: "connection",
      message:
        "We couldn't reach the mail server. Check the SMTP host and port (and your network), then try again.",
    };
  }
  if (
    responseCode === 421 ||
    responseCode === 450 ||
    responseCode === 451 ||
    responseCode === 452
  ) {
    return {
      category: "throttled",
      message:
        "The mail server is temporarily unavailable or deferring the send. Wait a moment, then try again.",
    };
  }
  if (
    code === "EENVELOPE" ||
    command === "RCPT TO" ||
    responseCode === 501 ||
    responseCode === 550 ||
    responseCode === 551 ||
    responseCode === 553
  ) {
    return {
      category: "recipient",
      message:
        "The recipient's email address was rejected by the mail server. Double-check the customer's email address, then try again.",
    };
  }
  if (code === "EMESSAGE" || responseCode === 552) {
    return {
      category: "message",
      message:
        "The mail server rejected the message (it may be too large). Try again, and contact support if it keeps happening.",
    };
  }
  return {
    category: "unknown",
    message:
      "We couldn't deliver the email right now. Please try again in a moment.",
  };
}

/**
 * Lazily run `transporter.verify()` once per process. Useful for surfacing
 * misconfigured SMTP credentials early without retrying on every send.
 */
export async function verifyMailer(): Promise<void> {
  const mailer = getMailer();
  if (!mailer) return;
  if (verifyPromise) return verifyPromise;
  verifyPromise = mailer
    .verify()
    .then(() => {
      logger.info("smtp.ready", { host: env.server.SMTP_HOST });
    })
    .catch((err) => {
      verifyPromise = null;
      logger.error("smtp.verify_failed", {
        host: env.server.SMTP_HOST,
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    });
  return verifyPromise;
}
