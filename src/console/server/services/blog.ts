import "server-only";

import { markdownToPlainText, readingMinutes } from "@/lib/blog/markdown";
import { isValidBlogSlug, slugifyTitle } from "@/lib/blog/slug";
import { isSafeImageUrl } from "@/lib/blog/url";
import { connectMongo } from "@/console/server/db/mongoose";
import { BlogPost, type BlogPostDoc } from "@/console/server/db/models";
import { recordAdminAction } from "@/console/server/audit";
import { assertConsoleAdmin } from "@/console/server/auth/session";

/**
 * Blog authoring — the admin side.
 *
 * ── What this module refuses to take from a caller ───────────────────────
 *
 * Every write function takes an explicit `actor` (the authenticated console
 * email, resolved server-side from the admin session) and NEVER reads an
 * author, owner or admin flag out of the payload. The route supplies the
 * actor; the client supplies only content.
 *
 * `status` and `publishedAt` are likewise not fields a caller can set.
 * `createPost` and `updatePost` do not look at them at all — publication is
 * `publishPost` / `unpublishPost`, which are separate, separately audited
 * operations. A client that POSTs `{ status: "PUBLISHED" }` to the update
 * endpoint changes nothing, which is the property worth having: there is no
 * shape of update body that puts a draft on the public internet.
 *
 * ── Slug immutability ────────────────────────────────────────────────────
 *
 * A slug may be edited freely while a post has never been published. Once
 * `everPublished` is true the URL is public and load-bearing, and a change is
 * refused. Renaming a live URL silently 404s every inbound link and share,
 * and there is no redirect table to catch them.
 */

const MAX_TAGS = 8;
const MAX_TAG_LENGTH = 40;

export interface BlogPostRow {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  body: string;
  coverImageUrl: string | null;
  coverImageAlt: string | null;
  authorName: string;
  tags: string[];
  status: string;
  publishedAt: string | null;
  everPublished: boolean;
  seoTitle: string | null;
  seoDescription: string | null;
  readingMinutes: number;
  updatedByEmail: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

function toRow(d: BlogPostDoc): BlogPostRow {
  return {
    id: String(d._id),
    slug: d.slug,
    title: d.title,
    excerpt: d.excerpt ?? "",
    body: d.body ?? "",
    coverImageUrl: d.coverImageUrl ?? null,
    coverImageAlt: d.coverImageAlt ?? null,
    authorName: d.authorName ?? "",
    tags: Array.isArray(d.tags) ? d.tags : [],
    status: d.status,
    publishedAt: d.publishedAt ? new Date(d.publishedAt).toISOString() : null,
    everPublished: Boolean(d.everPublished),
    seoTitle: d.seoTitle ?? null,
    seoDescription: d.seoDescription ?? null,
    readingMinutes: d.readingMinutes ?? 1,
    updatedByEmail: d.updatedByEmail ?? null,
    createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : null,
    updatedAt: d.updatedAt ? new Date(d.updatedAt).toISOString() : null,
  };
}

/* ─── Normalisation ────────────────────────────────────────────────────── */

/** Lowercase, de-duplicate, cap. Tags are a grouping key, not free text. */
function normaliseTags(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const tag = raw.trim().toLowerCase().replace(/\s+/g, "-").slice(0, MAX_TAG_LENGTH);
    if (tag && /^[a-z0-9-]+$/.test(tag)) seen.add(tag);
    if (seen.size >= MAX_TAGS) break;
  }
  return [...seen];
}

/** An unsafe cover URL is dropped, never stored and never "fixed". */
function normaliseCover(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  return isSafeImageUrl(trimmed) ? trimmed : null;
}

export class BlogValidationError extends Error {}

export interface BlogPostInput {
  slug: string;
  title: string;
  excerpt?: string | null;
  body: string;
  coverImageUrl?: string | null;
  coverImageAlt?: string | null;
  authorName?: string | null;
  tags?: unknown;
  seoTitle?: string | null;
  seoDescription?: string | null;
}

/** Shared shape-checking for create and update. Throws, never coerces. */
function validate(input: BlogPostInput): void {
  if (!isValidBlogSlug(input.slug)) {
    throw new BlogValidationError(
      "Slug must be 3–80 lowercase letters, digits and single hyphens.",
    );
  }
  if (!input.title?.trim() || input.title.trim().length < 8) {
    throw new BlogValidationError("Title must be at least 8 characters.");
  }
  if (!input.body?.trim() || input.body.trim().length < 200) {
    throw new BlogValidationError(
      "Body must be at least 200 characters — a stub post is worse than no post.",
    );
  }
  // A cover image without alt text is an accessibility defect that ships to
  // every reader, so it is refused rather than defaulted.
  const cover = normaliseCover(input.coverImageUrl);
  if (cover && !input.coverImageAlt?.trim()) {
    throw new BlogValidationError(
      "A cover image needs alt text describing what it shows.",
    );
  }
  if (input.coverImageUrl?.trim() && !cover) {
    throw new BlogValidationError(
      "Cover image must be an https:// URL or a path on this site.",
    );
  }
}

function excerptFrom(input: BlogPostInput): string {
  const given = input.excerpt?.trim();
  if (given) return given.slice(0, 400);
  const text = markdownToPlainText(input.body);
  return text.length <= 200 ? text : `${text.slice(0, 197).trimEnd()}…`;
}

/* ─── Reads ────────────────────────────────────────────────────────────── */

export interface ListBlogResult {
  items: BlogPostRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export async function listBlogPosts(opts: {
  status?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}): Promise<ListBlogResult> {
  await assertConsoleAdmin();
  await connectMongo();
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 25));
  const filter: Record<string, unknown> = {};
  if (opts.status && opts.status !== "ALL") filter.status = opts.status;
  if (opts.search?.trim()) {
    const escaped = opts.search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rx = new RegExp(escaped, "i");
    filter.$or = [{ title: rx }, { slug: rx }];
  }

  const [docs, total] = await Promise.all([
    BlogPost.find(filter)
      // The body is large and the list never renders it.
      .select({ body: 0 })
      .sort({ updatedAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean<BlogPostDoc[]>(),
    BlogPost.countDocuments(filter),
  ]);

  return {
    items: docs.map(toRow),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/** One post by id, INCLUDING drafts. Admin-authenticated callers only. */
export async function getBlogPost(id: string): Promise<BlogPostRow | null> {
  await assertConsoleAdmin();
  await connectMongo();
  if (!/^[a-f0-9]{24}$/i.test(id)) return null;
  const doc = await BlogPost.findById(id).lean<BlogPostDoc>();
  return doc ? toRow(doc) : null;
}

export async function countDraftPosts(): Promise<number> {
  await assertConsoleAdmin();
  await connectMongo();
  return BlogPost.countDocuments({ status: "DRAFT" });
}

/* ─── Writes ───────────────────────────────────────────────────────────── */

export async function createBlogPost(
  input: BlogPostInput,
  actor: string,
  ip: string | null,
): Promise<BlogPostRow> {
  await assertConsoleAdmin();
  validate(input);
  await connectMongo();

  const slug = input.slug.trim().toLowerCase();
  const existing = await BlogPost.findOne({ slug }).select({ _id: 1 }).lean();
  if (existing) {
    throw new BlogValidationError(
      `The slug "${slug}" is already taken. Pick another — slugs are permanent once published.`,
    );
  }

  const doc = await BlogPost.create({
    slug,
    title: input.title.trim(),
    excerpt: excerptFrom(input),
    body: input.body,
    coverImageUrl: normaliseCover(input.coverImageUrl),
    coverImageAlt: input.coverImageAlt?.trim() || null,
    // Falls back to the console operator's own email-derived name, never to
    // an author id the client could choose.
    authorName: input.authorName?.trim() || actor,
    tags: normaliseTags(input.tags),
    seoTitle: input.seoTitle?.trim() || null,
    seoDescription: input.seoDescription?.trim() || null,
    readingMinutes: readingMinutes(input.body),
    // Always a draft. There is no create-and-publish path: publishing is its
    // own audited action.
    status: "DRAFT",
    publishedAt: null,
    everPublished: false,
    updatedByEmail: actor,
  });

  await recordAdminAction({
    actorEmail: actor,
    action: "blog.create",
    targetType: "blog_post",
    targetId: String(doc._id),
    metadata: { slug },
    ip,
  });

  return toRow(doc.toObject() as BlogPostDoc);
}

export async function updateBlogPost(
  id: string,
  input: BlogPostInput,
  actor: string,
  ip: string | null,
): Promise<BlogPostRow> {
  await assertConsoleAdmin();
  validate(input);
  await connectMongo();
  if (!/^[a-f0-9]{24}$/i.test(id)) throw new BlogValidationError("Unknown post.");

  const current = await BlogPost.findById(id).lean<BlogPostDoc>();
  if (!current) throw new BlogValidationError("Unknown post.");

  const slug = input.slug.trim().toLowerCase();
  if (slug !== current.slug) {
    if (current.everPublished) {
      throw new BlogValidationError(
        "This post has been published, so its URL is permanent. Changing the slug would 404 every existing link to it.",
      );
    }
    const clash = await BlogPost.findOne({ slug, _id: { $ne: id } })
      .select({ _id: 1 })
      .lean();
    if (clash) {
      throw new BlogValidationError(`The slug "${slug}" is already taken.`);
    }
  }

  await BlogPost.updateOne(
    { _id: id },
    {
      $set: {
        slug,
        title: input.title.trim(),
        excerpt: excerptFrom(input),
        body: input.body,
        coverImageUrl: normaliseCover(input.coverImageUrl),
        coverImageAlt: input.coverImageAlt?.trim() || null,
        authorName: input.authorName?.trim() || current.authorName || actor,
        tags: normaliseTags(input.tags),
        seoTitle: input.seoTitle?.trim() || null,
        seoDescription: input.seoDescription?.trim() || null,
        readingMinutes: readingMinutes(input.body),
        updatedByEmail: actor,
      },
      // `status`, `publishedAt` and `everPublished` are deliberately absent
      // from this $set. An update can never change publication state.
    },
  );

  await recordAdminAction({
    actorEmail: actor,
    action: "blog.update",
    targetType: "blog_post",
    targetId: id,
    metadata: { slug },
    ip,
  });

  const updated = await BlogPost.findById(id).lean<BlogPostDoc>();
  return toRow(updated as BlogPostDoc);
}

/**
 * Publish. Sets `publishedAt` to now on first publication and leaves the
 * original date alone on a re-publish, so an article that was briefly
 * unpublished does not jump to the top of the index on its return.
 */
export async function publishBlogPost(
  id: string,
  actor: string,
  ip: string | null,
): Promise<BlogPostRow> {
  await assertConsoleAdmin();
  await connectMongo();
  if (!/^[a-f0-9]{24}$/i.test(id)) throw new BlogValidationError("Unknown post.");
  const current = await BlogPost.findById(id).lean<BlogPostDoc>();
  if (!current) throw new BlogValidationError("Unknown post.");

  // Re-validate at the publication boundary rather than trusting that the
  // last update validated. A post written before a rule existed, or seeded by
  // a script, must still clear it before it becomes public.
  validate({
    slug: current.slug,
    title: current.title,
    body: current.body,
    coverImageUrl: current.coverImageUrl,
    coverImageAlt: current.coverImageAlt,
  });

  await BlogPost.updateOne(
    { _id: id },
    {
      $set: {
        status: "PUBLISHED",
        publishedAt: current.publishedAt ?? new Date(),
        everPublished: true,
        updatedByEmail: actor,
      },
    },
  );

  await recordAdminAction({
    actorEmail: actor,
    action: "blog.publish",
    targetType: "blog_post",
    targetId: id,
    metadata: { slug: current.slug },
    ip,
  });

  const updated = await BlogPost.findById(id).lean<BlogPostDoc>();
  return toRow(updated as BlogPostDoc);
}

/** Unpublish. Keeps `publishedAt` and `everPublished` — the URL stays taken
 *  and the original date survives a re-publish. */
export async function unpublishBlogPost(
  id: string,
  actor: string,
  ip: string | null,
): Promise<BlogPostRow> {
  await assertConsoleAdmin();
  await connectMongo();
  if (!/^[a-f0-9]{24}$/i.test(id)) throw new BlogValidationError("Unknown post.");
  const current = await BlogPost.findById(id).lean<BlogPostDoc>();
  if (!current) throw new BlogValidationError("Unknown post.");

  await BlogPost.updateOne(
    { _id: id },
    { $set: { status: "DRAFT", updatedByEmail: actor } },
  );

  await recordAdminAction({
    actorEmail: actor,
    action: "blog.unpublish",
    targetType: "blog_post",
    targetId: id,
    metadata: { slug: current.slug },
    ip,
  });

  const updated = await BlogPost.findById(id).lean<BlogPostDoc>();
  return toRow(updated as BlogPostDoc);
}

/**
 * Delete permanently.
 *
 * Refused for a post that has ever been published: the URL is in indexes,
 * inbound links and shares, and deleting the row turns all of them into 404s
 * with no way back. Unpublish first — that removes it from the public site
 * and is reversible.
 */
export async function deleteBlogPost(
  id: string,
  actor: string,
  ip: string | null,
): Promise<void> {
  await assertConsoleAdmin();
  await connectMongo();
  if (!/^[a-f0-9]{24}$/i.test(id)) throw new BlogValidationError("Unknown post.");
  const current = await BlogPost.findById(id).lean<BlogPostDoc>();
  if (!current) throw new BlogValidationError("Unknown post.");
  if (current.everPublished) {
    throw new BlogValidationError(
      "This post has been published. Unpublish it instead — deleting it would 404 every link that already points at the URL.",
    );
  }

  await BlogPost.deleteOne({ _id: id });
  await recordAdminAction({
    actorEmail: actor,
    action: "blog.delete",
    targetType: "blog_post",
    targetId: id,
    metadata: { slug: current.slug },
    ip,
  });
}

/** Slug suggestion for the admin form. Never applied automatically. */
export function suggestSlug(title: string): string {
  return slugifyTitle(title);
}
