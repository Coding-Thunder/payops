/**
 * Seed the blog with the articles in `src/server/content/blog-seed.ts`.
 *
 *   npm run seed:blog                 # dry run against .env.local
 *   npm run seed:blog -- --apply
 *   npm run seed:blog:prod -- --apply # requires .env.prod in the environment
 *
 * ── Safety properties ────────────────────────────────────────────────────
 *
 *  1. DRY RUN IS THE DEFAULT. Nothing is written without `--apply`. The only
 *     write calls in this file sit after the `--apply` guard.
 *
 *  2. IDEMPOTENT. Posts are matched by slug. A second run against an
 *     unchanged seed file reports "unchanged" for every post and writes
 *     nothing.
 *
 *  3. IT DOES NOT PUBLISH. Seeded posts are created as DRAFTS. Publishing is
 *     an editorial decision taken in the admin console, where it is audited
 *     against a named operator. A script that put content on the public
 *     internet as a side effect of running would be a script nobody could
 *     safely run twice.
 *
 *  4. IT DOES NOT OVERWRITE EDITS BY DEFAULT. If a post's body has been
 *     changed in the console since it was seeded, the script reports the
 *     divergence and skips it. `--force` overwrites — which is the right
 *     thing when the repository is the source being corrected, and the wrong
 *     thing by accident.
 *
 *  5. IT NEVER DELETES. Removing a post from the seed file does not remove it
 *     from the database; the script says so and leaves it alone.
 */

import mongoose from "mongoose";

import { readingMinutes } from "../src/lib/blog/markdown";
import { isValidBlogSlug } from "../src/lib/blog/slug";
import { BLOG_SEED_POSTS } from "../src/server/content/blog-seed";

interface Flags {
  apply: boolean;
  force: boolean;
}

function parseFlags(argv: string[]): Flags {
  return {
    apply: argv.includes("--apply"),
    force: argv.includes("--force"),
  };
}

/**
 * Minimal schema over the same collection. The script does not import the app
 * model, which pulls in `server-only` and the whole model registry.
 *
 * `strict: false` so the script neither depends on nor constrains the
 * authoritative schema — the app model in `blog-post.model.ts` owns that. The
 * TypeScript shape below is only what THIS script reads and writes.
 */
interface SeedDoc {
  slug: string;
  title: string;
  excerpt: string;
  body: string;
  authorName: string;
  tags: string[];
  seoTitle: string | null;
  seoDescription: string | null;
  readingMinutes: number;
  coverImageUrl: string | null;
  coverImageAlt: string | null;
  updatedByEmail: string | null;
  status: string;
  publishedAt: Date | null;
  everPublished: boolean;
}

const seedSchema = new mongoose.Schema<SeedDoc>(
  {},
  { strict: false, collection: "blog_posts", timestamps: true },
);
const SeedPost = mongoose.model<SeedDoc>("SeedBlogPost", seedSchema);

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2));
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI is not set.");
    return 1;
  }

  // Validate the seed file BEFORE connecting. A malformed slug should fail
  // without a database round trip, and without a partial write.
  const slugs = new Set<string>();
  for (const post of BLOG_SEED_POSTS) {
    if (!isValidBlogSlug(post.slug)) {
      console.error(`Invalid slug in seed file: "${post.slug}"`);
      return 1;
    }
    if (slugs.has(post.slug)) {
      console.error(`Duplicate slug in seed file: "${post.slug}"`);
      return 1;
    }
    slugs.add(post.slug);
    if (post.body.trim().length < 200) {
      console.error(`Seed post "${post.slug}" is too short to publish.`);
      return 1;
    }
  }

  await mongoose.connect(uri);
  console.log(
    `\n${flags.apply ? "APPLY" : "DRY RUN"} — ${BLOG_SEED_POSTS.length} seed posts\n`,
  );

  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let skipped = 0;

  for (const post of BLOG_SEED_POSTS) {
    const existing = await SeedPost.findOne({ slug: post.slug }).lean<
      (SeedDoc & Record<string, unknown>) | null
    >();

    const doc = {
      slug: post.slug,
      title: post.title,
      excerpt: post.excerpt,
      body: post.body,
      authorName: post.authorName,
      tags: post.tags,
      seoTitle: post.seoTitle ?? null,
      seoDescription: post.seoDescription ?? null,
      readingMinutes: readingMinutes(post.body),
      coverImageUrl: null,
      coverImageAlt: null,
      updatedByEmail: "seed-script",
    };

    if (!existing) {
      console.log(`  + create   ${post.slug}`);
      if (flags.apply) {
        await SeedPost.create({
          ...doc,
          // Always a draft — see safety property 3.
          status: "DRAFT",
          publishedAt: null,
          everPublished: false,
        });
      }
      created += 1;
      continue;
    }

    const sameContent =
      existing.title === doc.title &&
      existing.body === doc.body &&
      existing.excerpt === doc.excerpt;

    if (sameContent) {
      console.log(`  = unchanged ${post.slug}`);
      unchanged += 1;
      continue;
    }

    // Diverged. Either the console edited it, or the seed file moved on.
    const editedInConsole =
      existing.updatedByEmail && existing.updatedByEmail !== "seed-script";
    if (editedInConsole && !flags.force) {
      console.log(
        `  ~ SKIP     ${post.slug} — edited in the console by ${String(
          existing.updatedByEmail,
        )}. Re-run with --force to overwrite.`,
      );
      skipped += 1;
      continue;
    }

    console.log(`  * update   ${post.slug}`);
    if (flags.apply) {
      // `status`, `publishedAt` and `everPublished` are deliberately absent:
      // updating content must never change publication state, including for
      // a post an operator has already published.
      await SeedPost.updateOne({ slug: post.slug }, { $set: doc });
    }
    updated += 1;
  }

  const seedSlugs = [...slugs];
  const orphans = await SeedPost.find({ slug: { $nin: seedSlugs } })
    .select({ slug: 1, status: 1 })
    .lean<{ slug: string; status?: string }[]>();
  if (orphans.length) {
    console.log(
      `\n  ${orphans.length} post(s) exist in the database but not in the seed file. Left untouched:`,
    );
    for (const o of orphans) {
      console.log(`    · ${o.slug} (${o.status ?? "unknown"})`);
    }
  }

  console.log(
    `\n${flags.apply ? "Applied" : "Would apply"}: ${created} created, ${updated} updated, ${unchanged} unchanged, ${skipped} skipped.`,
  );
  if (!flags.apply) console.log("Re-run with --apply to write.\n");
  else if (created || updated) {
    console.log(
      "Seeded posts are DRAFTS. Publish them from /admin/blog when you are ready.\n",
    );
  }

  await mongoose.disconnect();
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch(async (err) => {
    console.error(err);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
