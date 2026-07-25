import "server-only";

import crypto from "node:crypto";

import { env } from "@/server/env";

/**
 * EXACT replica of the main app's password-reset token scheme
 * (`src/server/services/password-reset.service.ts`). Format:
 *   base64url("{userId}.{passwordHashHead}.{iatSec}.{hmac}")
 * signed with the SHARED `JWT_SECRET`, so a link minted here validates
 * on the main app's `/reset-password/<token>` route unchanged.
 *
 * `passwordHashHead` is the first 8 chars of the bcrypt hash — the token
 * auto-invalidates the moment the password changes.
 */
function secret(): string {
  return env.server.JWT_SECRET;
}

function hmac(value: string): string {
  return crypto.createHmac("sha256", secret()).update(value).digest("base64url");
}

export function passwordHashHead(passwordHash: string): string {
  return passwordHash.slice(0, 8);
}

/**
 * NOTE: the main app's `parseResetToken` splits the decoded payload on "."
 * and requires exactly 4 parts, so `passwordHash.slice(0,8)` must not
 * contain a ".". bcrypt's salt can start with "." (~1/64); callers
 * (provision.ts) re-hash until the head is dot-free before minting.
 */
export function generateResetToken(userId: string, passwordHash: string): string {
  const iatSec = Math.floor(Date.now() / 1000);
  const head = passwordHashHead(passwordHash);
  const payload = `${userId}.${head}.${iatSec}`;
  const sig = hmac(payload);
  return Buffer.from(`${payload}.${sig}`, "utf8").toString("base64url");
}

export function buildSetPasswordUrl(token: string): string {
  const base = env.server.MAIN_APP_URL.replace(/\/$/, "");
  return `${base}/reset-password/${token}`;
}
