import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";

import { BLOG_INDEX_PATH } from "@/lib/blog/slug";
import { SEO_LANDING_PATHS } from "@/lib/seo-routes";

const ISSUER = "tracetxn";
const AUDIENCE = "tracetxn:web";

/**
 * The platform console's session, mirrored from
 * `@/console/server/auth/session`. Duplicated rather than imported because
 * that module is `server-only` and pulls the console env parse; the proxy
 * must stay importable from the middleware runtime.
 *
 * If any of these three change there, they must change here — a mismatch
 * fails closed (every console request bounces to the login page), which is
 * the safe direction for a mistake to fall.
 */
const ADMIN_COOKIE = "admin_session";
const ADMIN_ISSUER = "tracetxn-admin";
const ADMIN_AUDIENCE = "tracetxn-admin:web";

/**
 * Route taxonomy
 * ──────────────
 *  /              → marketing landing (public)
 *  /login         → sign-in (public, redirects to /app/dashboard once authed)
 *  /pay/*         → customer-facing payment surfaces (public, gateway-bound)
 *  /consent/*     → hosted consent confirmation (public, HMAC-token bound)
 *  /api/*         → API routes, auth applied selectively below
 *  /app/*         → the entire authed product
 *  /admin/*       → platform super-admin console, own session, NOT gated here
 *
 * The authed product moved from a `(app)` route group to a literal
 * `/app` URL prefix so the root path can serve the marketing site.
 */

/** Public exact paths that never require auth. */
const PUBLIC_PATHS = [
  "/",
  "/login",
  "/signup",
  "/forgot-password",
  // Marketing surfaces. Every page below either renders static
  // brand-v1 content or POSTs to an already-public API. Without
  // these entries, an unauthenticated visitor clicking a footer
  // link gets bounced to /login, which kills SEO + customer trust.
  "/pricing",
  "/features",
  "/security",
  "/contact",
  "/waitlist",
  // Beta account activation via a single-use invitation token. Must be
  // reachable unauthenticated; the token (validated + consumed in the route)
  // is the credential.
  "/activate",
  // Client-management SEO landing pages. Spread from the registry rather
  // than listed here: this gate is deny-by-default, so a page added to the
  // registry but forgotten here would 307 to /login and be uncrawlable —
  // which is exactly what happened the first time these shipped.
  ...SEO_LANDING_PATHS,
  // Blog index. Individual posts are covered by the `/blog/` prefix below.
  BLOG_INDEX_PATH,
  // Public reviews page and its submission endpoint. The endpoint stores a
  // PENDING review and can never publish one; moderation happens in the
  // console.
  "/reviews",
  "/api/reviews",
  // Legal pages — long-form documents referenced from signup
  // click-wrap, footer, and DPA workflows. Public by definition.
  "/terms",
  "/privacy",
  "/refunds",
  "/dpa",
  "/api/auth/login",
  "/api/auth/signup",
  "/api/auth/forgot-password",
  "/api/auth/reset-password",
  // Firebase ID-token → session cookie exchange. The caller has a
  // verified Firebase ID token but no TraceTxn cookie yet (this is
  // the endpoint that mints it). Must be unauthenticated to be
  // reachable, token verification is the trust boundary inside
  // the route handler.
  "/api/auth/firebase-session",
  "/api/webhooks/stripe",
  "/api/health",
  "/api/quotations",
  // Public beta application + token-gated activation.
  "/api/beta/apply",
  "/api/beta/activate",
  // Team-invite activation endpoint. Public + unauthenticated but token-gated
  // (single-use hashed token); the invited member has no session yet.
  "/api/team/activate",
  // Founder-console impersonation handoff. The operator has NO session on
  // this app; the single-use, short-lived token (verified + burned inside
  // the route) is the credential. The route mints the actual session.
  "/api/impersonate/start",
];

/** Public path prefixes for marketing + customer-facing flows. */
const PUBLIC_PREFIXES = [
  // Blog posts: `/blog/<slug>`. Editorial content on the public marketing
  // site — no session, no tenant, nothing to gate. The route itself 404s for
  // an unpublished slug, so the draft boundary is enforced where the data is
  // read rather than here.
  "/blog/",
  "/pay/",
  // Token-bound password reset URLs of the form
  // `/reset-password/<base64url-token>`. The server-side route
  // verifies the HMAC; an invalid token surfaces a generic error.
  "/reset-password/",
  // Team-invite join URLs of the form `/join/<single-use-token>`. The
  // invited member has no session; the token in the URL is the credential
  // and the page verifies it before rendering the set-password form.
  "/join/",
  // Hosted consent flow is the customer's first stop after they click
  // the email's primary CTA. They have no session, the HMAC token in
  // the URL is the credential. Both the page and the JSON endpoint are
  // whitelisted; consent.service verifies the token before touching DB.
  "/consent/",
  "/api/consent/",
  // Per-org gateway webhook URLs. The orgId path segment is parsed by
  // the route handler; auth is via Stripe's signature header verified
  // against the tenant's webhook secret in `gateway_credentials`. We
  // exempt the whole prefix so any future gateway (Razorpay, etc.) can
  // mount under `/api/webhooks/<gateway>/<orgId>` without re-touching
  // the proxy.
  "/api/webhooks/",
];

/**
 * TENANT admin-only path prefixes (super_admin + admin) — the org-level admin
 * surface inside the product. NOT the platform console at `/admin`, which is
 * a different application boundary with its own session; see
 * `isPlatformConsole()`.
 */
const ADMIN_PATH_PREFIXES = ["/app/admin", "/api/admin"];

/**
 * The platform super-admin console, mounted at `/admin` (`src/app/admin/**`).
 *
 * It was a separate Next app on its own hostname until it was merged in, and
 * it authenticates with its OWN cookie (`admin_session`) against its OWN
 * allow-list — a tenant session grants nothing there and vice versa. So this
 * proxy, which exists to gate tenant sessions, must not touch it:
 *
 *   - The console's login page IS `/admin`, and its credential endpoints are
 *     `/admin/api/auth/*`. Gating them would 307 the login flow to `/login`
 *     (a 307 preserves the method, so the browser would re-POST the OTP
 *     request there) and nobody could ever sign in.
 *   - Observe-only impersonation 403s every mutating request on this origin.
 *     Now that the console shares the origin, that would block every console
 *     POST/DELETE for an operator who happens to be mid-impersonation.
 *
 * Both are avoided by `isConsolePublic()` below, which exempts exactly the
 * login page and the credential endpoints and NOTHING else.
 *
 * ── Why the proxy now gates the rest of the console ──────────────────────
 *
 * It used to let every `/admin/**` request through untouched, on the reasoning
 * that `requireAdminPage()` in `src/app/admin/(protected)/layout.tsx` guards
 * the pages and each route handler calls `getAdminEmail()`.
 *
 * That reasoning was wrong for PAGES, and the failure was silent. A layout
 * `redirect()` does not prevent the page segment from rendering: the App
 * Router renders layout and page CONCURRENTLY, so by the time the redirect is
 * emitted the page's RSC payload already exists and Next attaches it to the
 * 307 response. A browser follows the Location header and discards the body,
 * which is exactly why this was invisible in manual testing — but `curl`, a
 * crawler, a proxy log or any non-browser client reads the body and gets the
 * fully-rendered admin page. Measured on production before this fix:
 * `/admin/users` returned 307 with 51 KB containing 16 real user email
 * addresses; `/admin/beta-applications` leaked applicant emails; the console's
 * review pages would have leaked reviewer emails, their submitting IP and the
 * internal moderation note.
 *
 * The only place that can stop a page rendering is BEFORE rendering starts,
 * which is here. So the proxy now requires a cryptographically valid admin
 * session for every console path except the login surfaces, and returns
 * without ever invoking the route.
 *
 * DEFENCE IN DEPTH, not replacement. This checks the JWT only — signature,
 * issuer, audience, expiry. It deliberately does NOT re-check the
 * `admin_users` allow-list, because that is a database read and the proxy runs
 * on every request. `requireAdminPage()` and `getAdminEmail()` still run
 * afterwards and still do that check, so revoking an operator still takes
 * effect on their very next request even though their cookie is still
 * cryptographically valid.
 *
 * Matched as exact-or-slash on purpose: a bare `startsWith("/admin")` would
 * also swallow a future `/administrators` route and silently make it public.
 */
function isPlatformConsole(pathname: string): boolean {
  return pathname === "/admin" || pathname.startsWith("/admin/");
}

/**
 * The console surfaces that must stay reachable WITHOUT a session, because
 * they are how a session is obtained in the first place.
 *
 * Deliberately an exact allow-list rather than a prefix: `/admin/api/auth/`
 * covers request-otp, verify-otp, google and logout, and nothing else under
 * `/admin` is public. A new console route is therefore protected by default,
 * which is the direction a mistake should fall.
 */
function isConsolePublic(pathname: string): boolean {
  return (
    pathname === "/admin" ||
    pathname === "/admin/" ||
    pathname.startsWith("/admin/api/auth/")
  );
}

/**
 * True when the request carries a valid, unexpired platform-admin session.
 *
 * Signature + issuer + audience + expiry only. See the note on defence in
 * depth above: the allow-list re-check stays in `getAdminEmail()`.
 */
async function hasAdminSession(req: NextRequest): Promise<boolean> {
  const token = req.cookies.get(ADMIN_COOKIE)?.value;
  if (!token) return false;
  const raw = process.env.ADMIN_SESSION_SECRET || process.env.JWT_SECRET;
  if (!raw) return false;
  try {
    await jwtVerify(token, new TextEncoder().encode(raw), {
      issuer: ADMIN_ISSUER,
      audience: ADMIN_AUDIENCE,
      algorithms: ["HS256"],
    });
    return true;
  } catch {
    return false;
  }
}

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.includes(pathname)) return true;
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) return true;
  if (pathname.startsWith("/_next")) return true;
  if (pathname.startsWith("/favicon")) return true;
  if (pathname.startsWith("/static")) return true;
  if (pathname.startsWith("/assets")) return true;
  // PWA + SEO + metadata assets. Browsers fetch the manifest WITHOUT
  // credentials, and crawlers hit robots/sitemap with no session — so
  // gating these bounced them to /login and the browser tried to parse
  // an HTML login page as JSON ("manifest syntax error"), while search
  // engines got a redirect instead of the sitemap. All are public by
  // definition (they're referenced from the <head> of public pages).
  if (pathname === "/manifest.webmanifest") return true;
  if (pathname === "/robots.txt" || pathname === "/sitemap.xml") return true;
  if (pathname.startsWith("/icon")) return true;
  if (pathname.startsWith("/apple-icon")) return true;
  if (pathname.startsWith("/opengraph-image")) return true;
  // Marketing screenshots + any landing imagery served from
  // public/marketing/. Without this they'd 307 through proxy → /login
  // and the landing page would render broken images.
  if (pathname.startsWith("/marketing/")) return true;
  // Public per-org brand logo route. Customer surfaces (transactional
  // emails, /pay landing) hot-link these without any session — the URL
  // itself carries the orgId segment.
  if (pathname.startsWith("/api/branding/logo/")) return true;
  // Marketing surface only lives at "/"; everything else routed through
  // here gets evaluated normally.
  return false;
}

function isAdmin(pathname: string): boolean {
  return ADMIN_PATH_PREFIXES.some((p) => pathname.startsWith(p));
}

async function verifyToken(token: string, secret: Uint8Array) {
  try {
    const { payload } = await jwtVerify(token, secret, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ["HS256"],
    });
    return payload as {
      sub: string;
      email: string;
      name: string;
      role: "SUPER_ADMIN" | "ADMIN" | "STAFF";
      /** Present only on a founder-console impersonation session. */
      imp?: { by?: string; obs?: boolean };
    };
  } catch {
    return null;
  }
}

/**
 * Next.js 16 renamed the `middleware` file convention to `proxy`. The
 * exported function name follows suit, semantics are identical, this is
 * just the deprecated-warning fix.
 */
export async function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  // Before anything else, and before the session cookie is read — see
  // `isPlatformConsole()`.
  //
  // The only thing we do is stamp the requested path onto the forwarded
  // headers. A server component cannot otherwise learn its own URL, and the
  // console's auth guard needs it to send an unauthenticated operator back to
  // where they were going after signing in. Request headers are client-
  // supplied, so `requireAdminPage()` re-validates this as a console path
  // before putting it in a redirect.
  if (isPlatformConsole(pathname)) {
    if (!isConsolePublic(pathname) && !(await hasAdminSession(req))) {
      // A route handler gets JSON so its contract stays "401 + error body"
      // rather than becoming a redirect its client cannot follow. Note this
      // is belt-and-braces: every console handler already calls
      // getAdminEmail() and 401s on its own.
      if (pathname.startsWith("/admin/api/")) {
        return NextResponse.json(
          { ok: false, error: { code: "UNAUTHORIZED", message: "Not signed in" } },
          { status: 401 },
        );
      }
      // A page gets the console login, preserving where they were going —
      // the same destination `requireAdminPage()` used to redirect to, except
      // that now nothing has rendered, so the response carries no body.
      const url = new URL("/admin", req.url);
      const target = pathname + search;
      if (target && target !== "/admin") url.searchParams.set("next", target);
      return NextResponse.redirect(url);
    }
    const headers = new Headers(req.headers);
    headers.set("x-console-path", pathname + search);
    return NextResponse.next({ request: { headers } });
  }
  if (isPublic(pathname)) return NextResponse.next();

  const cookieName = process.env.COOKIE_NAME || "tracetxn_session";
  const token = req.cookies.get(cookieName)?.value;
  const secret = process.env.JWT_SECRET
    ? new TextEncoder().encode(process.env.JWT_SECRET)
    : null;

  if (!token || !secret) {
    return redirectToLogin(req, pathname + search);
  }

  const payload = await verifyToken(token, secret);
  if (!payload) return redirectToLogin(req, pathname + search);

  // Observe-only impersonation: hard-block every state-changing request at
  // the edge — API routes AND page server actions — so an operator viewing
  // a user's account can never mutate it. GET/HEAD pass through. The only
  // exceptions are the escape hatches that end the impersonation session.
  if (payload.imp?.obs === true) {
    const method = (req.method || "GET").toUpperCase();
    const mutating =
      method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
    const escapeHatch =
      pathname === "/api/impersonate/exit" || pathname === "/api/auth/logout";
    if (mutating && !escapeHatch) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "IMPERSONATION_READONLY",
            message: "Blocked — this session is read-only (impersonation).",
          },
        },
        { status: 403 },
      );
    }
  }

  // Impersonation NEVER grants the platform/admin console — not even when
  // impersonating an admin or org owner, whose real role would otherwise
  // pass the admin gate below. Support means "see their app", not "read
  // their admin surface" (the founder console covers cross-tenant admin
  // data). Applies in observe-only AND full-action; every /app/admin +
  // /api/admin request during an impersonation session is refused.
  if (payload.imp && isAdmin(pathname)) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "IMPERSONATION_NO_ADMIN",
            message: "The admin console is unavailable while impersonating.",
          },
        },
        { status: 403 },
      );
    }
    return NextResponse.redirect(new URL("/app/dashboard", req.url));
  }

  if (isAdmin(pathname) && payload.role === "STAFF") {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        {
          ok: false,
          error: { code: "FORBIDDEN", message: "Admin role required" },
        },
        { status: 403 },
      );
    }
    return NextResponse.redirect(new URL("/app/dashboard", req.url));
  }

  // Already-authed users hitting the login OR signup page bounce
  // into the app. The marketing root deliberately stays accessible
  // to authed users (operators sometimes link to it from external
  // docs and the public surface should always render).
  if (pathname === "/login" || pathname === "/signup") {
    return NextResponse.redirect(new URL("/app/dashboard", req.url));
  }

  const res = NextResponse.next();
  res.headers.set("x-user-id", payload.sub);
  res.headers.set("x-user-role", payload.role);
  return res;
}

function redirectToLogin(req: NextRequest, next: string) {
  const url = new URL("/login", req.url);
  if (next && next !== "/login") url.searchParams.set("next", next);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    /*
     * Match all request paths except the ones that should bypass the
     * proxy entirely:
     *   - _next internals
     *   - favicon.ico
     *   - /public asset folders we ship logos / images from:
     *       /assets, /providers, /branding, /static
     *     (Without this, customer-facing emails embed image URLs that
     *      hit our auth gate and redirect to /login, Gmail then caches
     *      that redirect via its /meips proxy and the inline logo
     *      renders as a broken image.)
     *   - stripe webhook (must keep raw body)
     */
    "/((?!_next/static|_next/image|favicon.ico|icon|apple-icon|opengraph-image|manifest.webmanifest|robots.txt|sitemap.xml|assets|providers|branding|marketing|static|api/webhooks).*)",
  ],
};
