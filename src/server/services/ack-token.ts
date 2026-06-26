import "server-only";

import crypto from "node:crypto";

import { env } from "@/lib/env";
import { BadRequestError } from "@/lib/errors";

/**
 * Terms-acknowledgement token: a base64url-encoded `ack.{orderId}.{iatSec}.{hmac}`
 * tuple signed with `CONSENT_TOKEN_SECRET` (falling back to `JWT_SECRET`).
 *
 * Mirrors `consent-token` but with an `ack` namespace baked into the signed
 * payload so a consent token can never be replayed as an acknowledgement
 * token (or vice-versa). Used by the post-payment "I Agree" link in the
 * confirmation email.
 */

/** 60 days — confirmation emails get acknowledged late more often than
 *  pre-payment consent links, so we give a longer window. */
const MAX_AGE_SECONDS = 60 * 24 * 60 * 60;
const NS = "ack";

function secret(): string {
  return env.server.CONSENT_TOKEN_SECRET ?? env.server.JWT_SECRET;
}

function hmac(value: string, key: string = secret()): string {
  return crypto.createHmac("sha256", key).update(value).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

export function generateAckToken(orderId: string): string {
  const iatSec = Math.floor(Date.now() / 1000);
  const payload = `${NS}.${orderId}.${iatSec}`;
  const sig = hmac(payload);
  return Buffer.from(`${payload}.${sig}`, "utf8").toString("base64url");
}

export interface ParsedAckToken {
  orderId: string;
  issuedAtSec: number;
}

export function parseAckToken(token: string): ParsedAckToken {
  let decoded: string;
  try {
    decoded = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    throw new BadRequestError("Invalid acknowledgement token");
  }
  const parts = decoded.split(".");
  // ns . orderId . iat . sig
  if (parts.length !== 4 || parts[0] !== NS) {
    throw new BadRequestError("Invalid acknowledgement token");
  }
  const [, orderId, iatStr, sig] = parts;
  const iatSec = Number.parseInt(iatStr, 10);
  if (!orderId || !Number.isFinite(iatSec) || iatSec <= 0 || !sig) {
    throw new BadRequestError("Invalid acknowledgement token");
  }
  const payload = `${NS}.${orderId}.${iatStr}`;
  const expected = hmac(payload);
  if (!safeEqual(sig, expected)) {
    const legacy = hmac(payload, env.server.JWT_SECRET);
    if (!safeEqual(sig, legacy)) {
      throw new BadRequestError("Invalid acknowledgement token");
    }
  }
  const now = Math.floor(Date.now() / 1000);
  if (now - iatSec > MAX_AGE_SECONDS) {
    throw new BadRequestError("This acknowledgement link has expired");
  }
  return { orderId, issuedAtSec: iatSec };
}

export function buildAckUrl(appUrl: string, token: string): string {
  const base = appUrl.replace(/\/$/, "");
  return `${base}/acknowledge/${token}`;
}
