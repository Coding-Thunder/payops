import { execSync } from "node:child_process";

import type { NextConfig } from "next";

/**
 * Resolve the deployed commit SHA at BUILD time so `/api/health` can echo it
 * — answering "is my latest push actually live?" with a single curl. Prefer a
 * platform-injected env var, else read it from git in the build checkout, else
 * "unknown". The value is inlined into the bundle via `env` below, so it is
 * frozen to whatever commit produced the running build.
 */
function resolveAppVersion(): string {
  const fromEnv =
    process.env.APP_VERSION ||
    process.env.SOURCE_VERSION ||
    process.env.COMMIT_SHA ||
    process.env.GIT_COMMIT_SHA;
  if (fromEnv) return fromEnv.slice(0, 12);
  try {
    return execSync("git rev-parse --short HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

const APP_VERSION = resolveAppVersion();
const BUILT_AT = new Date().toISOString();

const nextConfig: NextConfig = {
  // Frozen at build time — see resolveAppVersion(). Surfaced by /api/health.
  env: {
    APP_VERSION,
    BUILT_AT,
  },
  reactStrictMode: true,
  poweredByHeader: false,
  // Pin Turbopack's root to this app. The repo now contains a second
  // Next app (`admin/`) with its own package-lock.json; without an
  // explicit root, Turbopack's multi-lockfile heuristic can mis-detect
  // the workspace root. Pinning it keeps this app's build scoped to
  // itself and silences the "inferred workspace root" warning.
  turbopack: {
    root: __dirname,
  },
  // Skip the in-build TS pass — type-checking happens via `npm run
  // typecheck` (run locally + in CI). next build's bundled checker
  // exhausts the App Platform builder's 10GB heap on this codebase,
  // and the separate pass gives us identical coverage with a saner
  // memory profile.
  typescript: { ignoreBuildErrors: true },
  // Next 16 removed the `eslint` key — `next build` no longer bundles a
  // lint pass. Linting still runs via `npm run lint` locally and in CI.
  experimental: {
    serverActions: {
      bodySizeLimit: "1mb",
    },
  },
  serverExternalPackages: ["mongoose", "bcryptjs"],
  async redirects() {
    // Legacy URLs from the pre-/app/ layout — still bookmarked, still
    // linked from operator-internal docs. Permanent 308 so browsers
    // cache the new location and external referrers learn the new URL.
    return [
      { source: "/dashboard", destination: "/app/dashboard", permanent: true },
      {
        source: "/dashboard/:path*",
        destination: "/app/dashboard/:path*",
        permanent: true,
      },
    ];
  },
  async headers() {
    // CSP is intentionally strict on `default-src`/`object-src`/`base-uri`
    // — `script-src 'self'` would break Next 16's inline hydration helpers,
    // so we keep `'unsafe-inline'` there for now. The bigger win is
    // `object-src 'none'` + `frame-ancestors 'none'` (kills clickjacking
    // + plugin-based XSS), `form-action 'self'` (login can't post to
    // an attacker), and tightly scoped `connect-src` (the only outbound
    // calls the app should make at runtime are same-origin + Stripe).
    // Cloudflare Turnstile loads its API script + widget iframe from
    // `challenges.cloudflare.com`; whitelist it under script-src and
    // frame-src so the bot-check on /login + /api/quotations works.
    //
    // Firebase Auth needs three families of origins:
    //   - script-src: apis.google.com + www.gstatic.com (SDK + Google
    //     OAuth helpers), accounts.google.com (popup).
    //   - connect-src: identitytoolkit / securetoken / googleapis for
    //     REST + token refresh, *.firebaseapp.com for the hidden auth
    //     iframe's postMessage channel.
    //   - frame-src: *.firebaseapp.com (the reCAPTCHA-protected auth
    //     iframe used by createUserWithEmailAndPassword), and
    //     accounts.google.com (Google sign-in popup is technically a
    //     window, but some Firebase flows embed it as a frame).
    // Without these, the SDK iframe load hits CSP, fires el.onerror,
    // and the call throws auth/internal-error with no server response.
    //
    // `'unsafe-eval'` is dev-only: React uses eval() for debug helpers
    // (callstack reconstruction). Production builds never eval.
    const isDev = process.env.NODE_ENV !== "production";
    const scriptSrc = [
      "script-src",
      "'self'",
      "'unsafe-inline'",
      isDev ? "'unsafe-eval'" : null,
      "https://challenges.cloudflare.com",
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
        "https://api.stripe.com",
        "https://challenges.cloudflare.com",
        "https://identitytoolkit.googleapis.com",
        "https://securetoken.googleapis.com",
        "https://www.googleapis.com",
        "https://*.firebaseapp.com",
        "https://accounts.google.com",
      ].join(" "),
      "form-action 'self' https://*.stripe.com",
      [
        "frame-src 'self'",
        "https://*.stripe.com",
        "https://challenges.cloudflare.com",
        "https://*.firebaseapp.com",
        "https://accounts.google.com",
      ].join(" "),
    ].join("; ");

    // The platform super-admin console (`/admin/**`) shipped its own,
    // deliberately tighter CSP when it was a separate app: no Stripe, no
    // Turnstile — it talks to nothing but itself and Firebase/Google
    // sign-in. Merging it in must not silently widen that. The console CSP
    // below is the app CSP minus those two families, applied by a LATER
    // matching `headers` entry: Next resolves duplicate keys last-wins, so
    // `/admin/**` gets this one and every other path keeps the app CSP.
    // Every pattern is /g: `https://*.stripe.com` appears in BOTH form-action
    // and frame-src, and a string-argument `.replace()` would strip only the
    // first, silently leaving the console able to frame Stripe.
    const consoleCsp = csp
      .replace(/ https:\/\/api\.stripe\.com/g, "")
      .replace(/ https:\/\/\*\.stripe\.com/g, "")
      .replace(/ https:\/\/challenges\.cloudflare\.com/g, "");

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
          {
            // `same-origin-allow-popups` (not `same-origin`) is the
            // strictest COOP value that still allows Firebase's
            // signInWithPopup to postMessage back to the opener
            // window. Tightening to `same-origin` silently breaks the
            // Google sign-in flow with a swallowed postMessage and
            // surfaces as a hanging popup.
            key: "Cross-Origin-Opener-Policy",
            value: "same-origin-allow-popups",
          },
          {
            key: "Cross-Origin-Resource-Policy",
            value: "same-origin",
          },
          {
            key: "X-Permitted-Cross-Domain-Policies",
            value: "none",
          },
        ],
      },
      // ── Platform super-admin console ──────────────────────────────────
      // Must come AFTER the catch-all: for a duplicate header key, the last
      // matching entry wins. Two sources because `/admin/:path*` does not
      // match the bare `/admin` login page.
      //
      // Restores the two header guarantees the console had as a standalone
      // app and would otherwise lose here: its narrower CSP, and HSTS (the
      // catch-all block sets none — the main app only emits HSTS per-response
      // from `applySecurityHeaders()` on `withApi` JSON routes, which no
      // console handler goes through).
      ...["/admin", "/admin/:path*"].map((source) => ({
        source,
        headers: [
          { key: "Content-Security-Policy", value: consoleCsp },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000",
          },
        ],
      })),
    ];
  },
};

export default nextConfig;
