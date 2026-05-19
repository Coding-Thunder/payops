import type { MetadataRoute } from "next";

import { env } from "@/lib/env";

/**
 * robots.txt — surfaced by Next at `/robots.txt`.
 *
 *  - Crawlers may index the landing page and the login route.
 *  - Everything authed (`/app/*`), every API (`/api/*`), and every
 *    customer-facing token-bound surface (`/pay/*`, `/consent/*`)
 *    is disallowed: those URLs are either gated, single-use, or
 *    contain credential-like path segments that should never leak
 *    into a search index.
 *  - Sitemap URL pinned absolutely so crawlers reach it without
 *    relying on the request host.
 */
export default function robots(): MetadataRoute.Robots {
  const base = env.public.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");

  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/login"],
        disallow: [
          "/api/",
          "/app/",
          "/pay/",
          "/consent/",
        ],
      },
      {
        // AI crawlers — defensible default: opt OUT of being scraped
        // into LLM training corpora. The site exists to convert
        // prospects, not to feed a model. Easy to flip later if
        // marketing decides to allow.
        userAgent: ["GPTBot", "ClaudeBot", "Google-Extended", "CCBot", "Bytespider"],
        disallow: "/",
      },
    ],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
