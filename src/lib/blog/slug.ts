/**
 * Blog slugs.
 *
 * A slug is a PERMANENT public URL, which makes it the one field on a post
 * that is expensive to get wrong: changing it later breaks every inbound
 * link, every share, and whatever ranking the URL had accumulated. So it is
 * validated strictly and never auto-corrected on an existing post.
 *
 * Dependency-free so `src/proxy.ts` and client components can both use it.
 */

/**
 * Lowercase ASCII letters, digits and single hyphens. No leading, trailing or
 * doubled hyphen; 3–80 characters.
 *
 * ASCII-only is deliberate: a slug with non-ASCII characters percent-encodes
 * into an unreadable URL, and mixed scripts in a path invite homograph
 * confusion in a link a reader is deciding whether to trust.
 */
export const BLOG_SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const BLOG_SLUG_MIN = 3;
export const BLOG_SLUG_MAX = 80;

export function isValidBlogSlug(slug: string | null | undefined): boolean {
  if (typeof slug !== "string") return false;
  const s = slug.trim();
  return (
    s.length >= BLOG_SLUG_MIN &&
    s.length <= BLOG_SLUG_MAX &&
    BLOG_SLUG_REGEX.test(s)
  );
}

/**
 * Derive a slug from a title, as a STARTING POINT for the author.
 *
 * Only ever used to prefill the field in the admin form. It is not applied
 * silently on save: an author who edits the slug means it, and a title tweak
 * must not quietly move a published URL.
 */
export function slugifyTitle(title: string): string {
  return title
    .normalize("NFKD")
    // Strip combining marks so "Café" becomes "cafe" rather than "caf".
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, BLOG_SLUG_MAX)
    .replace(/-+$/, "");
}

/** Public URL path for a post. The single place that knows the shape. */
export const BLOG_INDEX_PATH = "/blog";

export function blogPostPath(slug: string): string {
  return `${BLOG_INDEX_PATH}/${slug}`;
}
