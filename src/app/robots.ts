import type { MetadataRoute } from "next";

import { env } from "@/lib/env";

/**
 * robots.txt — surfaced by Next at `/robots.txt`.
 *
 * Everything is disallowed. There is no marketing surface on a
 * single-merchant deployment: `/` redirects to a private operator sign-in,
 * and every customer-facing route (`/pay/*`, `/consent/*`,
 * `/acknowledge/*`) is single-use and carries a credential in its path, so
 * an indexed URL is a leaked one.
 *
 * `/acknowledge/` was previously missing from the disallow list even though
 * it is token-bound exactly like `/consent/`.
 */
export default function robots(): MetadataRoute.Robots {
  const base = env.public.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");

  return {
    rules: [{ userAgent: "*", disallow: "/" }],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
