import "server-only";

import crypto from "node:crypto";

import { env } from "@/lib/env";
import { BadRequestError } from "@/lib/errors";

/**
 * Consent token: a base64url-encoded `{consentId}.{iatSec}.{hmac}` triple,
 * signed with `CONSENT_TOKEN_SECRET` (falling back to `JWT_SECRET` for
 * backwards compat with deployments that haven't rotated yet). Verifying
 * the HMAC proves the token came from us and is unexpired, no DB hit
 * needed before we look the record up.
 *
 * Legacy format (`{consentId}.{hmac}` over consentId-only) is still
 * accepted by `parseConsentToken` so tokens issued before this revision
 * keep working until their consent record expires naturally.
 *
 * Why not JWT: we don't need the JWT envelope and keeping the token short
 * matters for email-client subject/URL truncation.
 */

/** Max age of a freshly-issued consent token. After 14 days a re-send
 *  is required, keeps a forwarded inbox from being a forever-back-door. */
const MAX_AGE_SECONDS = 14 * 24 * 60 * 60;

function secret(): string {
  return env.server.CONSENT_TOKEN_SECRET ?? env.server.JWT_SECRET;
}

function hmac(value: string, key: string = secret()): string {
  return crypto.createHmac("sha256", key).update(value).digest("base64url");
}

export function generateConsentToken(consentId: string): string {
  const iatSec = Math.floor(Date.now() / 1000);
  const payload = `${consentId}.${iatSec}`;
  const sig = hmac(payload);
  return Buffer.from(`${payload}.${sig}`, "utf8").toString("base64url");
}

export interface ParsedConsentToken {
  consentId: string;
  /** Issued-at, seconds since epoch. `null` for legacy un-dated tokens. */
  issuedAtSec: number | null;
}

export function parseConsentToken(token: string): ParsedConsentToken {
  let decoded: string;
  try {
    decoded = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    throw new BadRequestError("Invalid consent token");
  }
  const parts = decoded.split(".");
  if (parts.length === 3) {
    return parseDated(parts[0], parts[1], parts[2]);
  }
  if (parts.length === 2) {
    return parseLegacy(parts[0], parts[1]);
  }
  throw new BadRequestError("Invalid consent token");
}

function parseDated(
  consentId: string,
  iatStr: string,
  sig: string,
): ParsedConsentToken {
  if (!consentId || !iatStr || !sig) {
    throw new BadRequestError("Invalid consent token");
  }
  const iatSec = Number.parseInt(iatStr, 10);
  if (!Number.isFinite(iatSec) || iatSec <= 0) {
    throw new BadRequestError("Invalid consent token");
  }
  const payload = `${consentId}.${iatStr}`;
  const expected = hmac(payload);
  if (!safeEqual(sig, expected)) {
    // Try legacy secret too, in case the operator just rotated.
    const legacy = hmac(payload, env.server.JWT_SECRET);
    if (!safeEqual(sig, legacy)) {
      throw new BadRequestError("Invalid consent token");
    }
  }
  const now = Math.floor(Date.now() / 1000);
  if (now - iatSec > MAX_AGE_SECONDS) {
    throw new BadRequestError("This confirmation link has expired");
  }
  return { consentId, issuedAtSec: iatSec };
}

function parseLegacy(consentId: string, sig: string): ParsedConsentToken {
  if (!consentId || !sig) {
    throw new BadRequestError("Invalid consent token");
  }
  // Legacy tokens were signed over the bare consentId with the
  // (then-shared) JWT_SECRET. Verify against both possible keys so a
  // freshly rotated CONSENT_TOKEN_SECRET doesn't invalidate live tokens.
  const candidates = [
    hmac(consentId, env.server.JWT_SECRET),
    hmac(consentId, secret()),
  ];
  if (!candidates.some((c) => safeEqual(sig, c))) {
    throw new BadRequestError("Invalid consent token");
  }
  return { consentId, issuedAtSec: null };
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

export function buildConsentUrl(appUrl: string, token: string): string {
  const base = appUrl.replace(/\/$/, "");
  return `${base}/consent/${token}`;
}
