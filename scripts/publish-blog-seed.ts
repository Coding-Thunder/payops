/**
 * Publish the seeded blog articles through the console's own service.
 *
 *   npx tsx --env-file=<env> --require ./scripts/shim-server-only.cjs \
 *     scripts/publish-blog-seed.ts            # dry run
 *   … scripts/publish-blog-seed.ts --apply
 *
 * ── Why this exists rather than a `$set` on `status` ─────────────────────
 *
 * Publishing is not a field write. `publishBlogPost()` re-validates the post
 * at the publication boundary, sets `everPublished` (which is what makes the
 * slug permanent and blocks deletion of a live URL), preserves an existing
 * `publishedAt` across a re-publish, and writes an admin audit record. A raw
 * `updateOne({$set:{status:"PUBLISHED"}})` would skip all four, leaving a live
 * post whose URL could still be renamed or deleted out from under its inbound
 * links, with no record of who published it.
 *
 * So this is a thin driver for the same code path the console UI uses. The
 * only thing it does that the UI does not is run without a browser session,
 * which is why the actor is an explicit, self-describing system identity
 * rather than a real operator's address — attributing an automated run to a
 * person who did not click the button would make the audit log a lie.
 *
 * Publishes ONLY the slugs in the seed file. A post written later in the
 * console is never touched.
 */

import mongoose from "mongoose";

import { BLOG_SEED_POSTS } from "../src/server/content/blog-seed";
import {
  getBlogPost,
  listBlogPosts,
  publishBlogPost,
} from "../src/console/server/services/blog";

/** Self-describing, and matches what the seeder wrote to `updatedByEmail`. */
const ACTOR = "seed-script";

async function main(): Promise<number> {
  const apply = process.argv.includes("--apply");
  if (!process.env.MONGODB_URI) {
    console.error("MONGODB_URI is not set.");
    return 1;
  }

  console.log(`\n${apply ? "APPLY" : "DRY RUN"} — publishing seeded articles\n`);

  // The console service connects on demand; listing first also proves the
  // rows exist before anything is changed.
  const existing = await listBlogPosts({ status: "ALL", pageSize: 100 });
  const bySlug = new Map(existing.items.map((p) => [p.slug, p]));

  let published = 0;
  let already = 0;
  let missing = 0;
  let failed = 0;

  for (const seed of BLOG_SEED_POSTS) {
    const row = bySlug.get(seed.slug);
    if (!row) {
      console.log(`  ? missing    ${seed.slug} — run the seed first`);
      missing += 1;
      continue;
    }
    if (row.status === "PUBLISHED") {
      console.log(`  = already    ${seed.slug}`);
      already += 1;
      continue;
    }

    console.log(`  ↑ publish    ${seed.slug}`);
    if (!apply) {
      published += 1;
      continue;
    }
    try {
      // The real service: validates, stamps everPublished, audits.
      const after = await publishBlogPost(row.id, ACTOR, null);
      const check = await getBlogPost(row.id);
      if (after.status !== "PUBLISHED" || check?.status !== "PUBLISHED") {
        throw new Error(`status is ${check?.status ?? "unknown"} after publish`);
      }
      console.log(
        `               → ${check.status}, publishedAt=${check.publishedAt}, everPublished=${check.everPublished}`,
      );
      published += 1;
    } catch (err) {
      failed += 1;
      console.error(
        `  ✗ FAILED     ${seed.slug}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  console.log(
    `\n${apply ? "Published" : "Would publish"}: ${published}; already live: ${already}; missing: ${missing}; failed: ${failed}.`,
  );
  if (!apply) console.log("Re-run with --apply to write.\n");

  await mongoose.disconnect();
  return failed ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch(async (err) => {
    console.error(err);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
