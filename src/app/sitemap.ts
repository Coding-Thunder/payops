import type { MetadataRoute } from "next";

import { BLOG_INDEX_PATH, blogPostPath } from "@/lib/blog/slug";
import { SEO_LANDING_PAGES, absoluteUrl } from "@/lib/seo";
import { listPublishedSlugs } from "@/server/services/blog.service";

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
 *
 * BLOG POSTS are appended from the database rather than listed here. Two
 * consequences worth knowing:
 *
 *   - This route is `force-dynamic`. A build-time sitemap would freeze the
 *     post list at deploy time, so an article published on a Tuesday would
 *     not appear until the next deploy — which is the opposite of why you
 *     put articles in a sitemap.
 *   - The query is wrapped in a try/catch that falls back to the static
 *     entries. A sitemap that 500s is worse than one missing its blog
 *     section: a crawler that cannot fetch it stops re-fetching it.
 *
 * Only PUBLISHED posts appear, via the same `publishedFilter` the public
 * pages use — a draft URL in a sitemap is an invitation to crawl a 404.
 */
export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
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

  // Published articles. Never fatal: a database blip must not take the
  // sitemap down with it.
  let posts: MetadataRoute.Sitemap = [];
  try {
    const slugs = await listPublishedSlugs();
    posts = slugs.map((p) => ({
      url: absoluteUrl(blogPostPath(p.slug)),
      // The post's OWN last-modified date, not `now`. Stamping every URL with
      // the current time tells a crawler the whole site changed on every
      // fetch, which is how a sitemap loses its credibility as a signal.
      lastModified: p.updatedAt,
      changeFrequency: "yearly" as const,
      priority: 0.6,
    }));
  } catch {
    posts = [];
  }

  return [
    // Positioning surfaces.
    entry("/", 1, "weekly"),
    // Client-management SEO cluster. Derived from the registry in
    // `@/lib/seo` rather than listed by hand: publishing a page there is what
    // puts it in the sitemap, so the two cannot drift. Every entry is public,
    // indexable and its own canonical, which is this file's whole rule.
    ...SEO_LANDING_PAGES.map((page) =>
      entry(page.path, page.priority, "monthly"),
    ),
    entry("/features", 0.9, "monthly"),
    entry("/pricing", 0.8, "monthly"),
    // Conversion. During the private beta this is the public front door —
    // /signup is gated, so the waitlist is what a search visitor can act on.
    entry("/waitlist", 0.7, "monthly"),
    // Trust surfaces. Real ranking value for "is this safe to put client
    // data in", which is the objection this product has to clear.
    entry("/security", 0.7, "monthly"),
    // Reviews. Indexable even while empty: the page is a real, honest surface
    // and it is where reviews will accumulate.
    entry("/reviews", 0.6, "weekly"),
    entry("/contact", 0.5, "yearly"),
    // Legal. Low priority but genuinely indexable, and their absence looks
    // like a thin site to a crawler assessing the domain.
    entry("/privacy", 0.3, "yearly"),
    entry("/terms", 0.3, "yearly"),
    entry("/dpa", 0.3, "yearly"),
    entry("/refunds", 0.3, "yearly"),
    // Editorial. The index changes whenever a post is published; the posts
    // themselves carry their own lastModified above.
    ...(posts.length ? [entry(BLOG_INDEX_PATH, 0.7, "weekly")] : []),
    ...posts,
  ];
}
