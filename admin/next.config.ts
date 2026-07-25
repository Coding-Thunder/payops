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
};

export default nextConfig;
