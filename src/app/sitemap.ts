import type { MetadataRoute } from "next";

import { absoluteUrl } from "@/lib/seo";

/**
 * sitemap.xml, surfaced by Next at `/sitemap.xml`.
 *
 * Previously this listed exactly two URLs — `/` and `/login` — on the
 * reasoning that a multi-tenant SaaS has nothing else to crawl. That was
 * wrong in both directions: it withheld nine real marketing and legal pages
 * from discovery, and it advertised a sign-in form that has no business
 * ranking for anything.
 *
 * The rule for this file: a URL belongs here only if it is (a) public,
 * (b) indexable — i.e. it does NOT carry `robots: NOINDEX` — and (c) its own
 * canonical. Anything authed, tokenised, or single-use is excluded here AND
 * disallowed in robots.ts AND marked noindex on the route itself; see
 * src/app/robots.ts for that side of the contract.
 *
 * Deliberately absent, and why:
 *   /login /signup /forgot-password  auth forms, noindex (crawlable so the
 *                                    directive is actually seen)
 *   /activate /join/* /reset-password/*  single-use token URLs
 *   /pay/* /consent/*                customer one-time flows
 *   /app/* /admin/*                  authed surfaces
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();

  const entry = (
    path: string,
    priority: number,
    changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"],
  ) => ({
    url: absoluteUrl(path),
    lastModified: now,
    changeFrequency,
    priority,
  });

  return [
    // Positioning surfaces.
    entry("/", 1, "weekly"),
    entry("/features", 0.9, "monthly"),
    entry("/pricing", 0.8, "monthly"),
    // Conversion. During the private beta this is the public front door —
    // /signup is gated, so the waitlist is what a search visitor can act on.
    entry("/waitlist", 0.7, "monthly"),
    // Trust surfaces. Real ranking value for "is this safe to put client
    // data in", which is the objection this product has to clear.
    entry("/security", 0.7, "monthly"),
    entry("/contact", 0.5, "yearly"),
    // Legal. Low priority but genuinely indexable, and their absence looks
    // like a thin site to a crawler assessing the domain.
    entry("/privacy", 0.3, "yearly"),
    entry("/terms", 0.3, "yearly"),
    entry("/dpa", 0.3, "yearly"),
    entry("/refunds", 0.3, "yearly"),
  ];
}
