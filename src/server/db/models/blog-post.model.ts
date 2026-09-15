import {
  Schema,
  type HydratedDocument,
  type Model,
  type Types,
} from "mongoose";

import { BLOG_SLUG_MAX, BLOG_SLUG_REGEX } from "@/lib/blog/slug";
import { MAX_BODY_LENGTH } from "@/lib/blog/markdown";

import { registerModel } from "./register";

/**
 * A blog post.
 *
 * Editorial content authored in the admin console and published to the public
 * marketing site. NOT tenant data: a post belongs to the site, not to an
 * organization, so there is no `orgId` here and no tenant scoping anywhere in
 * its service. That is the one structural difference from every other model
 * in this directory, and it is deliberate — putting site content behind a
 * tenant filter would make it invisible to the public pages that need it.
 *
 * ── The publication boundary ─────────────────────────────────────────────
 *
 * `status` is the only thing separating a half-written draft from the public
 * internet, so it is treated as a security field rather than a UI toggle:
 *
 *   - It is NEVER accepted from a client payload. Publishing is a distinct,
 *     admin-authenticated endpoint, not a field on an update body. A client
 *     that POSTs `{ status: "PUBLISHED" }` changes nothing.
 *   - Every public read filters on `status: PUBLISHED` **and**
 *     `publishedAt <= now` — the second half is what makes scheduling safe.
 *     Neither the index nor the detail page can return a draft, and the
 *     detail page 404s rather than 403s so an unpublished slug is not even
 *     confirmed to exist.
 *
 * ── Slug immutability ────────────────────────────────────────────────────
 *
 * `slug` is the permanent public URL. It is unique and validated, and the
 * service refuses to change it on a post that has ever been published, since
 * doing so silently breaks every inbound link and share.
 */

export const BLOG_STATUSES = ["DRAFT", "PUBLISHED"] as const;
export type BlogStatus = (typeof BLOG_STATUSES)[number];

export const BlogStatusValue = {
  DRAFT: "DRAFT",
  PUBLISHED: "PUBLISHED",
} as const satisfies Record<string, BlogStatus>;

export interface BlogPostDoc {
  _id: Types.ObjectId;
  /** Permanent public URL segment. Unique, lowercase, hyphenated. */
  slug: string;
  title: string;
  /** Summary shown on the index and used as the meta description fallback. */
  excerpt: string;
  /** Markdown source. Rendered to React elements, never to an HTML string. */
  body: string;
  /** Absolute https URL or a site-relative path. Validated before storage. */
  coverImageUrl: string | null;
  /** Required whenever a cover image is set — an empty alt is a defect. */
  coverImageAlt: string | null;
  /** Display byline. Free text, not a user reference: posts outlive authors. */
  authorName: string;
  /** Lowercase topic tags, for grouping on the index. */
  tags: string[];
  status: BlogStatus;
  /**
   * When the post became (or becomes) public. Null while it has never been
   * published. A future value keeps it hidden — see the publication boundary.
   */
  publishedAt: Date | null;
  /** True once the post has been published at least once. Gates slug edits. */
  everPublished: boolean;
  /** Optional overrides; the title and excerpt are used when absent. */
  seoTitle: string | null;
  seoDescription: string | null;
  /** Denormalised at write time so the index does not parse every body. */
  readingMinutes: number;
  /** Console email of whoever last changed the post. Audit breadcrumb. */
  updatedByEmail: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type BlogPostDocument = HydratedDocument<BlogPostDoc>;

const blogPostSchema = new Schema<BlogPostDoc>(
  {
    slug: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: BLOG_SLUG_MAX,
      match: BLOG_SLUG_REGEX,
    },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    excerpt: { type: String, required: true, trim: true, maxlength: 400 },
    body: { type: String, required: true, maxlength: MAX_BODY_LENGTH },
    coverImageUrl: { type: String, default: null, trim: true, maxlength: 2048 },
    coverImageAlt: { type: String, default: null, trim: true, maxlength: 300 },
    authorName: { type: String, required: true, trim: true, maxlength: 120 },
    tags: {
      type: [String],
      default: [],
      // Capped so a post cannot become a tag farm; each tag is normalised and
      // length-checked by the service before it reaches here.
      validate: {
        validator: (v: string[]) => v.length <= 8,
        message: "A post can carry at most 8 tags",
      },
    },
    status: {
      type: String,
      required: true,
      enum: BLOG_STATUSES,
      default: BlogStatusValue.DRAFT,
    },
    publishedAt: { type: Date, default: null },
    everPublished: { type: Boolean, default: false },
    seoTitle: { type: String, default: null, trim: true, maxlength: 200 },
    seoDescription: { type: String, default: null, trim: true, maxlength: 400 },
    readingMinutes: { type: Number, default: 1, min: 1, max: 600 },
    updatedByEmail: { type: String, default: null, trim: true, maxlength: 254 },
  },
  { timestamps: true, versionKey: false, collection: "blog_posts" },
);

/** One post per slug. The unique index, not application code, is what makes
 *  two concurrent creates safe. */
blogPostSchema.index({ slug: 1 }, { unique: true });

/** The public index query: published posts, newest first. */
blogPostSchema.index({ status: 1, publishedAt: -1 });

/** The admin list, which spans both statuses and sorts by recency of edit. */
blogPostSchema.index({ updatedAt: -1 });

export const BlogPost = registerModel<BlogPostDoc>("BlogPost", blogPostSchema);
