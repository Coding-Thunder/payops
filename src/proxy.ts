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
  // Post-payment Terms acknowledgement — the "I Agree" button in the
  // confirmation email. Same model as /consent: the customer has NO staff
  // session, the signed ack token in the URL is the credential. Without
  // this, the proxy 307s the customer to /login (the internal ops portal).
  // acknowledgement.service verifies the HMAC token before any DB write.
  "/acknowledge/",
  "/api/acknowledge/",
  // Operator-uploaded provider and branding logos, served from GridFS by
  // GET /api/assets/<id>. These render on the payment, consent and
  // acknowledgement pages and inside confirmation emails, where the viewer
  // has NO staff session — without this the proxy 307s the image request to
  // /login and the customer sees a broken logo, which is the very bug the
  // durable asset store was added to fix. Safe to expose: the id is a random
  // ObjectId, a brand logo is not a secret, and the route refuses to serve
  // any content type outside the image allowlist.
  "/api/assets/",
  // Per-organization gateway webhooks: /api/webhooks/<provider>/<orgSlug>.
  // The deployment-level /api/webhooks/stripe is an exact PUBLIC_PATH above,
  // which does NOT cover sub-paths — without this prefix the proxy would
  // 307 a second organization's Stripe deliveries to /login and its
  // payments would silently never confirm. The slug in the URL grants
  // nothing: it only selects which signing secret to verify against, and an
  // event signed with the wrong key is rejected exactly like an unsigned
  // one.
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
  // Next's file-based metadata routes. These are fetched by link-preview
  // crawlers (WhatsApp, iMessage, Slack, Facebook, Twitter) and by the
  // browser chrome, none of which carry a session — so without this the
  // proxy 307s them to /login and the payment link a customer receives
  // previews with no image at all.
  //
  // This was masked until now: the root metadata used to point og:image at
  // /marketing/evidence-chain.webp, which the rule above already allowed.
  // That file is a screenshot of the internal operations console, so the
  // preview worked by leaking the wrong thing. Pointing og:image at the
  // generated card is what exposed the gap.
  //
  // Nothing here is sensitive: they are the brand card, the icons, the web
  // manifest, and the two crawler files, all derived from public branding.
  if (
    pathname === "/opengraph-image" ||
    pathname === "/twitter-image" ||
    pathname === "/icon" ||
    pathname === "/icon.svg" ||
    pathname === "/apple-icon" ||
    pathname === "/apple-icon.svg" ||
    pathname === "/manifest.webmanifest" ||
    pathname === "/robots.txt" ||
    pathname === "/sitemap.xml"
  ) {
    return true;
  }
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
    "/((?!_next/static|_next/image|favicon.ico|assets|providers|branding|static|api/webhooks/stripe).*)",
  ],
};
