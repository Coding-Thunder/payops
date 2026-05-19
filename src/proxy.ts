import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";

const ISSUER = "payops";
const AUDIENCE = "payops:web";

/**
 * Route taxonomy
 * ──────────────
 *  /              → marketing landing (public)
 *  /login         → sign-in (public, redirects to /app/dashboard once authed)
 *  /pay/*         → customer-facing payment surfaces (public, gateway-bound)
 *  /consent/*     → hosted consent confirmation (public, HMAC-token bound)
 *  /api/*         → API routes — auth applied selectively below
 *  /app/*         → the entire authed product
 *
 * The authed product moved from a `(app)` route group to a literal
 * `/app` URL prefix so the root path can serve the marketing site.
 */

/** Public exact paths that never require auth. */
const PUBLIC_PATHS = [
  "/",
  "/login",
  "/api/auth/login",
  "/api/webhooks/stripe",
  "/api/health",
  "/api/quotations",
];

/** Public path prefixes for marketing + customer-facing flows. */
const PUBLIC_PREFIXES = [
  "/pay/",
  // Hosted consent flow is the customer's first stop after they click
  // the email's primary CTA. They have no session — the HMAC token in
  // the URL is the credential. Both the page and the JSON endpoint are
  // whitelisted; consent.service verifies the token before touching DB.
  "/consent/",
  "/api/consent/",
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
 * exported function name follows suit — semantics are identical, this is
 * just the deprecated-warning fix.
 */
export async function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (isPublic(pathname)) return NextResponse.next();

  const cookieName = process.env.COOKIE_NAME || "payops_session";
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

  // Already-authed users hitting the login page bounce into the app.
  // Note we deliberately do NOT bounce them off the marketing root —
  // operators sometimes link to it from external docs and the public
  // surface should always render.
  if (pathname === "/login") {
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
     *      hit our auth gate and redirect to /login — Gmail then caches
     *      that redirect via its /meips proxy and the inline logo
     *      renders as a broken image.)
     *   - stripe webhook (must keep raw body)
     */
    "/((?!_next/static|_next/image|favicon.ico|assets|providers|branding|marketing|static|api/webhooks/stripe).*)",
  ],
};
