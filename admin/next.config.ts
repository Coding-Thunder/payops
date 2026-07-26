import type { NextConfig } from "next";

/**
 * Standalone admin console — separate DigitalOcean App Platform app.
 *
 * - `serverExternalPackages`: mongoose + bcryptjs must stay out of the
 *   bundler (native/dynamic requires), same as the main app.
 * - `ignoreBuildErrors`: type-checking runs via `npm run typecheck`
 *   (mirrors the main app; keeps the DO builder's heap sane).
 * - CSP + security headers: a strict Content-Security-Policy plus the
 *   standard hardening headers, with an explicit allow-list for Firebase /
 *   Google sign-in (script/connect/frame) so email OTP and the Google
 *   popup keep working. This is a Mission-Control console that impersonates
 *   and mutates production data, so it must never run without a CSP.
 *
 * Turbopack root MUST be pinned to this directory. DigitalOcean clones
 * the WHOLE monorepo to /workspace and only sets the working dir to
 * /workspace/admin — so BOTH the repo-root and admin package-lock.json
 * exist at build time. Without an explicit root, Turbopack's
 * multi-lockfile heuristic picks /workspace (the repo root), tries to
 * build the MAIN app's files, and can't resolve deps that were only
 * installed under /workspace/admin — surfacing as the build error
 * "Can't resolve 'jose'" from the main app's src/proxy.ts. Pinning the
 * root scopes module resolution + the build to THIS app.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  typescript: { ignoreBuildErrors: true },
  serverExternalPackages: ["mongoose", "bcryptjs"],
  turbopack: {
    root: __dirname,
  },
  async headers() {
    // `'unsafe-eval'` is dev-only (React debug helpers). `'unsafe-inline'`
    // on script-src stays because Next 16 emits inline hydration bootstrap.
    // Firebase/Google origins are allow-listed so signInWithPopup + the
    // hidden auth iframe + token refresh all work; everything else is
    // locked to 'self'.
    const isDev = process.env.NODE_ENV !== "production";
    const scriptSrc = [
      "script-src",
      "'self'",
      "'unsafe-inline'",
      isDev ? "'unsafe-eval'" : null,
      "https://apis.google.com",
      "https://www.gstatic.com",
      "https://accounts.google.com",
    ]
      .filter(Boolean)
      .join(" ");
    const csp = [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "img-src 'self' data: https:",
      "font-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      scriptSrc,
      [
        "connect-src 'self'",
        "https://identitytoolkit.googleapis.com",
        "https://securetoken.googleapis.com",
        "https://www.googleapis.com",
        "https://*.firebaseapp.com",
        "https://accounts.google.com",
      ].join(" "),
      "form-action 'self'",
      [
        "frame-src 'self'",
        "https://*.firebaseapp.com",
        "https://accounts.google.com",
      ].join(" "),
    ].join("; ");

    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          // Google sign-in is a popup that postMessages back to the opener,
          // so COOP must stay `same-origin-allow-popups` (not `same-origin`).
          {
            key: "Cross-Origin-Opener-Policy",
            value: "same-origin-allow-popups",
          },
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
          { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
