import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";

const ISSUER = "payops";
const AUDIENCE = "payops:web";

/** Public routes that never require auth. */
const PUBLIC_PATHS = [
  "/login",
  "/api/auth/login",
  "/api/webhooks/stripe",
  "/api/health",
];

/** Public path prefixes for customer-facing pages (no auth). */
const PUBLIC_PREFIXES = ["/pay/"];

/** Admin-only path prefixes (super_admin + admin). */
const ADMIN_PATH_PREFIXES = ["/admin", "/api/admin"];

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.includes(pathname)) return true;
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) return true;
  if (pathname.startsWith("/_next")) return true;
  if (pathname.startsWith("/favicon")) return true;
  if (pathname.startsWith("/static")) return true;
  if (pathname.startsWith("/assets")) return true;
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
    return NextResponse.redirect(new URL("/dashboard", req.url));
  }

  if (pathname === "/" || pathname === "/login") {
    return NextResponse.redirect(new URL("/dashboard", req.url));
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
     * Match all request paths except the ones that should bypass middleware:
     *   - _next internals
     *   - favicon.ico
     *   - public assets folder
     *   - stripe webhook (must keep raw body)
     */
    "/((?!_next/static|_next/image|favicon.ico|assets|api/webhooks/stripe).*)",
  ],
};
