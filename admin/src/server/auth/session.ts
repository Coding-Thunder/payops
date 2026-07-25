import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SignJWT, jwtVerify } from "jose";

import { env } from "@/server/env";
import { isAllowedEmail, normalizeEmail } from "./allowlist";

/**
 * Admin session = a short-lived jose JWT in an httpOnly, SameSite=strict,
 * Secure cookie. Separate cookie name + secret from the main app so the
 * two sessions never cross. Every read re-checks the allow-list, so
 * removing an email from ADMIN_ALLOWLIST revokes access on the next
 * request even with a still-valid cookie.
 */
const COOKIE_NAME = "admin_session";
const ISSUER = "tracetxn-admin";
const AUDIENCE = "tracetxn-admin:web";

let cachedKey: Uint8Array | null = null;
function key(): Uint8Array {
  if (cachedKey) return cachedKey;
  const raw = env.server.ADMIN_SESSION_SECRET || env.server.JWT_SECRET;
  cachedKey = new TextEncoder().encode(raw);
  return cachedKey;
}

function ttlSeconds(): number {
  return env.server.ADMIN_SESSION_TTL_HOURS * 60 * 60;
}

export async function signAdminSession(email: string): Promise<string> {
  return new SignJWT({ role: "PLATFORM_ADMIN", email: normalizeEmail(email) })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setSubject(normalizeEmail(email))
    .setExpirationTime(`${ttlSeconds()}s`)
    .sign(key());
}

async function verifyToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, key(), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ["HS256"],
    });
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

export async function setAdminCookie(token: string): Promise<void> {
  const store = await cookies();
  store.set({
    name: COOKIE_NAME,
    value: token,
    httpOnly: true,
    sameSite: "strict",
    secure: env.server.COOKIE_SECURE || env.server.NODE_ENV === "production",
    path: "/",
    domain: env.server.COOKIE_DOMAIN || undefined,
    maxAge: ttlSeconds(),
  });
}

export async function clearAdminCookie(): Promise<void> {
  const store = await cookies();
  store.set({
    name: COOKIE_NAME,
    value: "",
    httpOnly: true,
    sameSite: "strict",
    secure: env.server.COOKIE_SECURE || env.server.NODE_ENV === "production",
    path: "/",
    domain: env.server.COOKIE_DOMAIN || undefined,
    maxAge: 0,
  });
}

/**
 * The single source of truth for "is this request an admin?".
 * Returns the verified, still-allow-listed email or null.
 */
export async function getAdminEmail(): Promise<string | null> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (!token) return null;
  const email = await verifyToken(token);
  if (!email) return null;
  if (!isAllowedEmail(email)) return null;
  return email;
}

/** Server-component guard: redirect to the login page when unauthenticated. */
export async function requireAdminPage(): Promise<string> {
  const email = await getAdminEmail();
  if (!email) redirect("/");
  return email;
}
