import "server-only";

import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";

import { env } from "@/server/env";

/**
 * Founder-console impersonation — CONSOLE side (mint the handoff token).
 *
 * The console can't set the main app's session cookie, so it signs a
 * short-lived (60s), single-use token with the shared IMPERSONATION_SECRET
 * and hands the operator a redirect into the main app's
 * `/api/impersonate/start`, which verifies + burns it and mints the actual
 * session. This token grants nothing by itself.
 */

const ISSUER = "tracetxn:console";
const AUDIENCE = "tracetxn:impersonate";
const TOKEN_TTL = "60s";

export function impersonationEnabled(): boolean {
  return Boolean(env.server.IMPERSONATION_SECRET);
}

export async function signImpersonationToken(input: {
  targetUserId: string;
  by: string;
  observeOnly: boolean;
}): Promise<string | null> {
  const secret = env.server.IMPERSONATION_SECRET;
  if (!secret) return null;
  return new SignJWT({ by: input.by, obs: input.observeOnly })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(input.targetUserId)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(TOKEN_TTL)
    .sign(new TextEncoder().encode(secret));
}

export function impersonationStartUrl(token: string): string {
  const base = env.server.MAIN_APP_URL.replace(/\/$/, "");
  return `${base}/api/impersonate/start?token=${encodeURIComponent(token)}`;
}
