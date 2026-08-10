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
export interface SmtpTransportConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

/** Per-organization transports, keyed by their connection identity so each
 *  brand reuses one pool instead of dialling per send. */
const orgTransports = new Map<string, Transporter>();

/**
 * Transport for a specific organization's SMTP account.
 *
 * Separate pool per organization: nodemailer bakes credentials into the
 * transport, so two brands on different mailboxes cannot share one. Keyed on
 * the full connection identity (including the password) so a rotated
 * password produces a new transport rather than silently reusing a pool
 * authenticated with the old one.
 */
export function getMailerFor(config: SmtpTransportConfig): Transporter {
  const key = `${config.host}:${config.port}:${config.secure}:${config.user}:${config.pass}`;
  const existing = orgTransports.get(key);
  if (existing) return existing;

  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: {
      user: config.user,
      // Google App Passwords are displayed with spaces; SMTP auth rejects
      // them. Same defensive strip as the deployment transport below.
      pass: config.pass.replace(/\s+/g, ""),
    },
    pool: true,
    maxConnections: 3,
    maxMessages: 100,
    connectionTimeout: 10_000,
    socketTimeout: 20_000,
  });
  orgTransports.set(key, transport);
  return transport;
}

/** Test-only: drop cached per-organization transports. */
export function _resetOrgMailersForTests(): void {
  orgTransports.clear();
}

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
