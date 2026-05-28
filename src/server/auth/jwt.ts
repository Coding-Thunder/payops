import { SignJWT, jwtVerify } from "jose";

import { env } from "@/lib/env";
import { UserRole } from "@/lib/constants/enums";

const ISSUER = "tracetxn";
const AUDIENCE = "tracetxn:web";

export interface SessionPayload {
  sub: string;
  email: string;
  name: string;
  role: UserRole;
  /** Active organization for this session. Optional during the
   *  single-tenant → multi-tenant migration window: tokens signed
   *  pre-migration carry no orgId and the session resolver falls back
   *  to `User.primaryOrgId`. Newly issued tokens always include it. */
  orgId?: string;
  /** Every organization the user is a member of (any status). Used by
   *  the future org-switcher UI to enumerate options without an extra
   *  query on every page. Stays small (typically 1 today, single-digit
   *  later). Optional for back-compat. */
  orgIds?: string[];
}

let cachedKey: Uint8Array | null = null;
function key(): Uint8Array {
  if (cachedKey) return cachedKey;
  cachedKey = new TextEncoder().encode(env.server.JWT_SECRET);
  return cachedKey;
}

/** Hard upper bound: 7 days. Stops an env typo like `JWT_EXPIRES_IN=12d`
 *  from turning every session into a near-permanent credential. */
const MAX_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
/** Sensible fallback when the env value is missing / malformed. */
const DEFAULT_SESSION_TTL_SECONDS = 12 * 60 * 60;

/** Parse human friendly TTL ("12h", "30m") into seconds, clamped to
 *  [60s, 7d] so a misconfigured env can't ship long-lived sessions. */
function parseTtlSeconds(input: string): number {
  const m = input.match(/^(\d+)([smhd])$/);
  if (!m) return DEFAULT_SESSION_TTL_SECONDS;
  const value = Number(m[1]);
  const unit = m[2];
  let seconds: number;
  switch (unit) {
    case "s":
      seconds = value;
      break;
    case "m":
      seconds = value * 60;
      break;
    case "h":
      seconds = value * 60 * 60;
      break;
    case "d":
      seconds = value * 60 * 60 * 24;
      break;
    default:
      seconds = DEFAULT_SESSION_TTL_SECONDS;
  }
  return Math.max(60, Math.min(seconds, MAX_SESSION_TTL_SECONDS));
}

export function getSessionTtlSeconds(): number {
  return parseTtlSeconds(env.server.JWT_EXPIRES_IN);
}

export async function signSession(payload: SessionPayload): Promise<string> {
  const ttl = getSessionTtlSeconds();
  const claims: Record<string, unknown> = {
    email: payload.email,
    name: payload.name,
    role: payload.role,
  };
  // Only include org claims when present. Pre-migration code that calls
  // `signSession` without an orgId continues to produce a backwards-
  // compatible token — `verifySession` returns `orgId: undefined` and
  // the session resolver falls back to `User.primaryOrgId`.
  if (payload.orgId) claims.orgId = payload.orgId;
  if (payload.orgIds && payload.orgIds.length > 0) {
    claims.orgIds = payload.orgIds;
  }
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setSubject(payload.sub)
    .setExpirationTime(`${ttl}s`)
    .sign(key());
}

export async function verifySession(
  token: string,
): Promise<SessionPayload | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ["HS256"],
    });
    if (
      typeof payload.sub !== "string" ||
      typeof payload.email !== "string" ||
      typeof payload.role !== "string" ||
      typeof payload.name !== "string"
    ) {
      return null;
    }
    const orgId =
      typeof payload.orgId === "string" && payload.orgId.length > 0
        ? payload.orgId
        : undefined;
    const orgIdsRaw = Array.isArray(payload.orgIds) ? payload.orgIds : null;
    const orgIds = orgIdsRaw
      ? orgIdsRaw.filter((id): id is string => typeof id === "string" && id.length > 0)
      : undefined;
    return {
      sub: payload.sub,
      email: payload.email as string,
      name: payload.name as string,
      role: payload.role as UserRole,
      orgId,
      orgIds,
    };
  } catch {
    return null;
  }
}
