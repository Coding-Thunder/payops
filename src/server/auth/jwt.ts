import { SignJWT, jwtVerify } from "jose";

import { env } from "@/lib/env";
import { UserRole } from "@/lib/constants/enums";

const ISSUER = "payops";
const AUDIENCE = "payops:web";

export interface SessionPayload {
  sub: string;
  email: string;
  name: string;
  role: UserRole;
}

let cachedKey: Uint8Array | null = null;
function key(): Uint8Array {
  if (cachedKey) return cachedKey;
  cachedKey = new TextEncoder().encode(env.server.JWT_SECRET);
  return cachedKey;
}

/** Parse human friendly TTL ("12h", "30m") into seconds. */
function parseTtlSeconds(input: string): number {
  const m = input.match(/^(\d+)([smhd])$/);
  if (!m) return 60 * 60 * 12;
  const value = Number(m[1]);
  const unit = m[2];
  switch (unit) {
    case "s":
      return value;
    case "m":
      return value * 60;
    case "h":
      return value * 60 * 60;
    case "d":
      return value * 60 * 60 * 24;
    default:
      return 60 * 60 * 12;
  }
}

export function getSessionTtlSeconds(): number {
  return parseTtlSeconds(env.server.JWT_EXPIRES_IN);
}

export async function signSession(payload: SessionPayload): Promise<string> {
  const ttl = getSessionTtlSeconds();
  return new SignJWT({
    email: payload.email,
    name: payload.name,
    role: payload.role,
  })
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
    return {
      sub: payload.sub,
      email: payload.email as string,
      name: payload.name as string,
      role: payload.role as UserRole,
    };
  } catch {
    return null;
  }
}
