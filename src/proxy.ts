import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";

const ISSUER = "tracetxn";
const AUDIENCE = "tracetxn:web";

/**
 * Route taxonomy
 * ──────────────
 *  /              → marketing landing (public)
 *  /login         → sign-in (public, redirects to /app/dashboard once authed)
 *  /pay/*         → customer-facing payment surfaces (public, gateway-bound)
 *  /consent/*     → hosted consent confirmation (public, HMAC-token bound)
 *  /api/*         → API routes, auth applied selectively below
 *  /app/*         → the entire authed product
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
];

/** Public path prefixes for marketing + customer-facing flows. */
const PUBLIC_PREFIXES = [
  "/pay/",
  // Token-bound password reset URLs of the form
  // `/reset-password/<base64url-token>`. The server-side route
  // verifies the HMAC; an invalid token surfaces a generic error.
  "/reset-password/",
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

/** Admin-only path prefixes (super_admin + admin). */
const ADMIN_PATH_PREFIXES = ["/app/admin", "/api/admin"];

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.includes(pathname)) return true;
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) return true;
  if (pathname.startsWith("/_next")) return true;
  if (pathname.startsWith("/favicon")) return true;
  if (pathname.startsWith("/static")) return true;
  if (pathname.startsWith("/assets")) return true;
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
    "/((?!_next/static|_next/image|favicon.ico|assets|providers|branding|marketing|static|api/webhooks).*)",
  ],
};
