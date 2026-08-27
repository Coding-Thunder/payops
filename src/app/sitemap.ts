import type { MetadataRoute } from "next";

/**
 * sitemap.xml — surfaced by Next at `/sitemap.xml`.
 *
 * Deliberately empty. This deployment serves one merchant's booking
 * payments and has no public surface worth indexing: `/` redirects to the
 * operator sign-in, `/app/*` and `/api/*` are authed, and `/pay/*`,
 * `/consent/*` and `/acknowledge/*` are single-use, token-bound customer
 * flows whose URLs contain the credential itself.
 *
 * The file stays rather than being deleted so `/sitemap.xml` answers with a
 * valid empty document instead of a 404, and so `robots.txt` can keep
 * pointing at it.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return [];
}
