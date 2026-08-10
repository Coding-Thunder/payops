import { cookies } from "next/headers";

import { env } from "@/lib/env";

/**
 * The currently-selected organization, carried in its own cookie rather
 * than as a JWT claim.
 *
 * Why not a claim on the session token: `verifySession` rejects a token
 * whose payload shape doesn't match, so adding a required `orgId` would
 * invalidate every live session the moment it deployed. Switching
 * organization would also mean re-issuing the session, which conflates
 * "who you are" with "what you are looking at". A separate cookie keeps
 * the two independent and lets the selection outlive nothing important —
 * if it is stale, wrong, or forged, the worst case is that the request is
 * treated as having no selection.
 *
 * Why it is NOT signed: signing would be theatre here. The cookie is a
 * *hint*; the authority is the membership row. Every read re-resolves the
 * id against `organization_members` for the authenticated user, so a
 * tampered value names an organization the user isn't a member of and is
 * rejected exactly like a random string. A signature would add key
 * management and a second failure mode while changing no outcome.
 *
 * Cookie attributes deliberately mirror the session cookie, including
 * `sameSite: "strict"` — that setting is one of the three CSRF layers this
 * app relies on (alongside the Origin check in `withApi` and the JSON
 * content-type requirement), and a weaker value here would undercut it.
 */

/** Derived from the session cookie name so a deployment that renames one
 *  renames both, and the pair stays recognisable in a browser inspector. */
export function orgCookieName(): string {
  return `${env.server.COOKIE_NAME}_org`;
}

/**
 * Selection lifetime. Deliberately longer than the session TTL: the
 * selection is not a credential, and an operator who signs back in should
 * land where they left off rather than re-picking their brand every
 * morning. It is re-validated against membership on every request, so an
 * orphaned selection is harmless.
 */
const SELECTION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export async function setSelectedOrgCookie(organizationId: string) {
  const { COOKIE_DOMAIN, COOKIE_SECURE, NODE_ENV } = env.server;
  const store = await cookies();
  store.set({
    name: orgCookieName(),
    value: organizationId,
    httpOnly: true,
    sameSite: "strict",
    secure: COOKIE_SECURE || NODE_ENV === "production",
    path: "/",
    domain: COOKIE_DOMAIN || undefined,
    maxAge: SELECTION_MAX_AGE_SECONDS,
  });
}

export async function clearSelectedOrgCookie() {
  const { COOKIE_DOMAIN, COOKIE_SECURE, NODE_ENV } = env.server;
  const store = await cookies();
  store.set({
    name: orgCookieName(),
    value: "",
    httpOnly: true,
    sameSite: "strict",
    secure: COOKIE_SECURE || NODE_ENV === "production",
    path: "/",
    domain: COOKIE_DOMAIN || undefined,
    maxAge: 0,
  });
}

export async function readSelectedOrgCookie(): Promise<string | null> {
  const store = await cookies();
  return store.get(orgCookieName())?.value || null;
}
