import "server-only";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { SignJWT, jwtVerify } from "jose";

import { env } from "@/console/server/env";
import { isAllowedEmail, normalizeEmail } from "./allowlist";
import { ADMIN_BASE, ADMIN_COOKIE_PATH } from "@/console/lib/paths";

/**
 * Admin session = a short-lived jose JWT in an httpOnly, SameSite=strict,
 * Secure cookie. Separate cookie name + secret from the main app so the
 * two sessions never cross. Every read re-checks the allow-list against
 * `admin_users`, so disabling an admin revokes access on the next request
 * even with a still-valid cookie.
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
    path: ADMIN_COOKIE_PATH,
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
    path: ADMIN_COOKIE_PATH,
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
  if (!(await isAllowedEmail(email))) return null;
  return email;
}

/**
 * Server-component guard: redirect to the console login when unauthenticated,
 * preserving where the operator was actually trying to go.
 *
 * Without the `next` param a bookmarked or Slack-shared deep link
 * (`/admin/orders/<id>`) is silently replaced by the dashboard after signing
 * in, and the operator has to find the record again by hand. The main app has
 * always done this (`/login?next=…` in `src/proxy.ts`); the console did not.
 */
export async function requireAdminPage(): Promise<string> {
  const email = await getAdminEmail();
  if (!email) {
    const target = await currentAdminPath();
    redirect(target ? `${ADMIN_BASE}?next=${encodeURIComponent(target)}` : ADMIN_BASE);
  }
  return email;
}

/**
 * The path (plus query) of the request being served, when it is a console
 * page. Read from the headers Next sets on every request; returns null when
 * unavailable or when the value isn't a console path, so the caller falls
 * back to the plain login URL.
 */
async function currentAdminPath(): Promise<string | null> {
  try {
    const h = await headers();
    // Set by `src/proxy.ts` for every /admin/** request. Next does not expose
    // the request URL to a server component any other way.
    const url = h.get("x-console-path");
    if (!url) return null;
    // The header arrives on a client-controllable request, so validate the
    // path before it can end up in a redirect.
    if (!isSafeConsolePath(url.split("?")[0])) return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * Only ever hand back a same-origin console path. This is the open-redirect
 * guard for the `next` round trip: anything that isn't `/admin` or
 * `/admin/...` (including protocol-relative `//evil.com`) is refused.
 */
export function isSafeConsolePath(value: string | null | undefined): boolean {
  if (!value) return false;
  if (!value.startsWith("/")) return false;
  if (value.startsWith("//")) return false;
  return value === ADMIN_BASE || value.startsWith(`${ADMIN_BASE}/`);
}
