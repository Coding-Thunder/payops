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
    // `'unsafe-eval'` is dev-only: React uses eval() for debug helpers
    // (callstack reconstruction). Production builds never eval.
    const isDev = process.env.NODE_ENV !== "production";
    const scriptSrc = [
      "script-src",
      "'self'",
      "'unsafe-inline'",
      isDev ? "'unsafe-eval'" : null,
      "https://challenges.cloudflare.com",
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
      "connect-src 'self' https://api.stripe.com https://challenges.cloudflare.com",
      "form-action 'self' https://*.stripe.com",
      "frame-src 'self' https://*.stripe.com https://challenges.cloudflare.com",
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
            key: "Cross-Origin-Opener-Policy",
            value: "same-origin",
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
