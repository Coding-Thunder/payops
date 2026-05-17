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
