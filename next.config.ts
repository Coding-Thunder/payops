import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
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
    ];
  },
};

export default nextConfig;
