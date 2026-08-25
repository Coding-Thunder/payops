import type { MetadataRoute } from "next";

import { SITE_URL, absoluteUrl } from "@/lib/seo";

/**
 * robots.txt, surfaced by Next at `/robots.txt`.
 *
 * The previous rule read `allow: ["/", "/login"]` alongside a disallow list,
 * which looked like an allow-list and was not one. In robots.txt `Allow`
 * only carves exceptions out of a `Disallow`; with no `Disallow: /` present,
 * everything unlisted was already crawlable. The intent is now explicit:
 * allow the whole site, then name every prefix that must stay out.
 *
 * Two rules of thumb encoded below:
 *
 *  1. A page that must not be INDEXED but is harmless to fetch (the auth
 *     forms) is left crawlable and carries `robots: NOINDEX` in its own
 *     metadata. Disallowing it here would hide that directive — a crawler
 *     that cannot fetch the page never learns it should not index it, and
 *     the URL can still surface from an external link.
 *
 *  2. A URL that must never be FETCHED — anything carrying a single-use
 *     token — is disallowed by prefix here as well as noindexed. The prefix
 *     leaks nothing: `/join/` is public knowledge, the token after it is not.
 *
 * robots.txt is a crawler convention, not access control. Every surface
 * below is independently protected by session auth or token verification;
 * these rules exist to keep URLs out of an index, nothing more.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          // Machine surfaces.
          "/api/",
          // Authed product + platform console. The console also sets
          // `robots: noindex` in its own layout, but that only helps once a
          // crawler has fetched it; the prefix keeps it out of the crawl.
          "/app/",
          "/admin",
          // Customer one-time flows bound to a token or a session.
          "/pay/",
          "/consent/",
          // Single-use credential-bearing links. Never fetched, never
          // indexed — a token in a search index is a live account takeover.
          "/join/",
          "/reset-password/",
          "/activate",
        ],
      },
      {
        // AI crawlers, defensible default: opt OUT of being scraped
        // into LLM training corpora. The site exists to convert
        // prospects, not to feed a model. Easy to flip later if
        // marketing decides to allow.
        userAgent: [
          "GPTBot",
          "ClaudeBot",
          "Google-Extended",
          "CCBot",
          "Bytespider",
        ],
        disallow: "/",
      },
    ],
    sitemap: absoluteUrl("/sitemap.xml"),
    host: SITE_URL,
  };
}
