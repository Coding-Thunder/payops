import type { NextConfig } from "next";

/**
 * Standalone admin console — separate DigitalOcean App Platform app.
 *
 * - `serverExternalPackages`: mongoose + bcryptjs must stay out of the
 *   bundler (native/dynamic requires), same as the main app.
 * - `ignoreBuildErrors`: type-checking runs via `npm run typecheck`
 *   (mirrors the main app; keeps the DO builder's heap sane).
 * - No custom CSP here: the browser default imposes no script/connect
 *   restrictions, so the Firebase Google sign-in popup works without the
 *   long allow-list the main app needs for its strict CSP.
 *
 * The local "multiple lockfiles" warning is cosmetic — the DO build sets
 * Source Directory to /admin, so only this app's lockfile is present.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  typescript: { ignoreBuildErrors: true },
  serverExternalPackages: ["mongoose", "bcryptjs"],
};

export default nextConfig;
