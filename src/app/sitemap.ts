import type { MetadataRoute } from "next";

import { env } from "@/lib/env";

/**
 * sitemap.xml — surfaced by Next at `/sitemap.xml`.
 *
 * Scope is intentionally tiny: PayOps is a privately-deployed SaaS,
 * the only crawler-eligible surfaces are the marketing landing and
 * the public login route. Everything else (`/app/*`, `/api/*`,
 * `/pay/*`, `/consent/*`) is either authed, token-gated, or a
 * customer-facing one-time flow that has no business being indexed.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = env.public.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  const now = new Date();

  return [
    {
      url: `${base}/`,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${base}/login`,
      lastModified: now,
      changeFrequency: "yearly",
      priority: 0.3,
    },
  ];
}
