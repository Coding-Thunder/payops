import "server-only";

import type { Types } from "mongoose";

import { markdownToPlainText, readingMinutes } from "@/lib/blog/markdown";
import { isValidBlogSlug } from "@/lib/blog/slug";
import { isSafeImageUrl } from "@/lib/blog/url";
import { BlogPost, BlogStatusValue, type BlogPostDoc } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";

/**
 * Blog reads for the PUBLIC site.
 *
 * Everything here is anonymous-readable by definition, so the only thing this
 * module has to get right is the publication boundary — and it gets exactly
 * one chance to define it, in `publishedFilter()`. Every public query in the
 * app composes that filter rather than writing `status: "PUBLISHED"` by hand,
 * because the boundary is two conditions and the second is easy to forget:
 *
 *   status === PUBLISHED   AND   publishedAt <= now
 *
 * Dropping the time comparison would make a post scheduled for next Tuesday
 * live immediately, which looks like a working feature right up to the moment
 * an embargo matters.
 *
 * Writes live in the console service (`@/console/server/services/blog`),
 * behind admin authentication. Nothing in this file mutates.
 */

/** The one definition of "publicly visible". Never inline this. */
function publishedFilter(now = new Date()) {
  return {
    status: BlogStatusValue.PUBLISHED,
    publishedAt: { $ne: null, $lte: now },
  } as const;
}

/** A post as the public pages consume it. Dates are ISO strings so the shape
 *  crosses the server/client boundary without serialisation surprises. */
export interface PublicBlogPost {
  slug: string;
  title: string;
  excerpt: string;
  body: string;
  coverImageUrl: string | null;
  coverImageAlt: string | null;
  authorName: string;
  tags: string[];
  publishedAt: string;
  updatedAt: string;
  readingMinutes: number;
  seoTitle: string | null;
  seoDescription: string | null;
}

/** The subset the index needs. Excludes `body`, which is the large field. */
export type BlogSummary = Omit<PublicBlogPost, "body">;

function toPublic(d: BlogPostDoc): PublicBlogPost {
  return {
    slug: d.slug,
    title: d.title,
    excerpt: d.excerpt,
    body: d.body,
    // Re-checked on the way out, not only on the way in. A URL that was
    // written before this validation existed, or by a script that bypassed
    // the service, must not reach an <img src>.
    coverImageUrl: isSafeImageUrl(d.coverImageUrl) ? d.coverImageUrl : null,
    coverImageAlt: d.coverImageAlt ?? null,
    authorName: d.authorName,
    tags: Array.isArray(d.tags) ? d.tags : [],
    // Non-null in practice: `publishedFilter` excludes null publishedAt.
    publishedAt: (d.publishedAt ?? d.createdAt).toISOString(),
    updatedAt: d.updatedAt.toISOString(),
    readingMinutes: d.readingMinutes || readingMinutes(d.body),
    seoTitle: d.seoTitle ?? null,
    seoDescription: d.seoDescription ?? null,
  };
}

/** Published posts, newest first. `limit` is clamped, not trusted. */
export async function listPublishedPosts(opts?: {
  limit?: number;
  tag?: string;
}): Promise<BlogSummary[]> {
  await connectMongo();
  const limit = Math.min(100, Math.max(1, opts?.limit ?? 50));
  const filter: Record<string, unknown> = { ...publishedFilter() };
  if (opts?.tag) {
    // Exact match on a normalised tag — never a regex built from input.
    filter.tags = opts.tag.trim().toLowerCase().slice(0, 40);
  }

  const docs = await BlogPost.find(filter)
    .select({ body: 0 })
    .sort({ publishedAt: -1 })
    .limit(limit)
    .lean<(BlogPostDoc & { _id: Types.ObjectId })[]>();

  return docs.map((d) => {
    // `body` was projected away; `toPublic` needs a string to fall back on
    // for reading time, and the stored value is authoritative anyway.
    const { body: _omitted, ...rest } = toPublic({ ...d, body: "" });
    return rest;
  });
}

/**
 * One published post by slug, or null.
 *
 * Returns null — never a partial or a "draft" marker — for a draft, a future
 * publication date, or a slug that does not exist. The caller renders a 404
 * for all three, so an unpublished URL is not confirmed to exist.
 */
export async function getPublishedPost(
  slug: string,
): Promise<PublicBlogPost | null> {
  if (!isValidBlogSlug(slug)) return null; // never reaches the database
  await connectMongo();
  const doc = await BlogPost.findOne({
    slug: slug.trim().toLowerCase(),
    ...publishedFilter(),
  }).lean<(BlogPostDoc & { _id: Types.ObjectId }) | null>();
  return doc ? toPublic(doc) : null;
}

/** Slugs and timestamps for the sitemap. Cheap projection, no bodies. */
export async function listPublishedSlugs(): Promise<
  { slug: string; updatedAt: Date; publishedAt: Date }[]
> {
  await connectMongo();
  const docs = await BlogPost.find(publishedFilter())
    .select({ slug: 1, updatedAt: 1, publishedAt: 1 })
    .sort({ publishedAt: -1 })
    .limit(1000)
    .lean<
      { slug: string; updatedAt: Date; publishedAt: Date | null }[]
    >();
  return docs.map((d) => ({
    slug: d.slug,
    updatedAt: d.updatedAt,
    publishedAt: d.publishedAt ?? d.updatedAt,
  }));
}

/**
 * Related posts for the end of an article: same tag first, then recent.
 *
 * Excludes the current post. Purely editorial — no personalisation, no
 * tracking, nothing that varies by reader.
 */
export async function listRelatedPosts(
  slug: string,
  tags: string[],
  limit = 3,
): Promise<BlogSummary[]> {
  await connectMongo();
  const base = { ...publishedFilter(), slug: { $ne: slug } };
  const take = Math.min(6, Math.max(1, limit));

  const sameTag = tags.length
    ? await BlogPost.find({ ...base, tags: { $in: tags.slice(0, 8) } })
        .select({ body: 0 })
        .sort({ publishedAt: -1 })
        .limit(take)
        .lean<(BlogPostDoc & { _id: Types.ObjectId })[]>()
    : [];

  let docs = sameTag;
  if (docs.length < take) {
    const seen = new Set(docs.map((d) => d.slug));
    const filler = await BlogPost.find({
      ...base,
      slug: { $nin: [slug, ...seen] },
    })
      .select({ body: 0 })
      .sort({ publishedAt: -1 })
      .limit(take - docs.length)
      .lean<(BlogPostDoc & { _id: Types.ObjectId })[]>();
    docs = [...docs, ...filler];
  }

  return docs.map((d) => {
    const { body: _omitted, ...rest } = toPublic({ ...d, body: "" });
    return rest;
  });
}

/** Plain-text summary used when a post carries no explicit excerpt. */
export function deriveExcerpt(body: string, max = 200): string {
  const text = markdownToPlainText(body);
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 60 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
