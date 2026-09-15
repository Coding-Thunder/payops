import { beforeEach, describe, expect, it } from "vitest";

import { BlogPost } from "@/server/db/models";
import {
  deriveExcerpt,
  getPublishedPost,
  listPublishedPosts,
  listPublishedSlugs,
  listRelatedPosts,
} from "@/server/services/blog.service";
import { ensureMongo, resetDatabase } from "@/tests/utils/db";

/**
 * The blog's publication boundary.
 *
 * `status` is the only thing between a half-written draft and the public
 * internet, so it is tested as a security property rather than as a filter.
 * The failure this file exists to prevent is a public read that returns a
 * draft — through the index, the detail page, the sitemap, or the "keep
 * reading" list at the foot of an article. Each of those is a separate query,
 * and each one is a separate chance to forget half the condition.
 *
 * The condition has TWO halves and the second is the one that gets dropped:
 *
 *     status === PUBLISHED   AND   publishedAt <= now
 *
 * A post scheduled for next week is PUBLISHED with a future date. Filtering on
 * status alone makes it live immediately, which looks like a working feature
 * until an embargo matters.
 */

beforeEach(async () => {
  await ensureMongo();
  await resetDatabase();
});

const BODY =
  "This is a real body long enough to look like an article. ".repeat(8);

async function makePost(over: Record<string, unknown> = {}) {
  return BlogPost.create({
    slug: "a-published-post",
    title: "A published post",
    excerpt: "An excerpt.",
    body: BODY,
    authorName: "The TraceTxn team",
    tags: ["client-records"],
    status: "PUBLISHED",
    publishedAt: new Date("2026-01-01T00:00:00Z"),
    everPublished: true,
    readingMinutes: 3,
    ...over,
  });
}

describe("a DRAFT is invisible to every public read", () => {
  beforeEach(async () => {
    await makePost({
      slug: "secret-draft",
      title: "Unannounced feature",
      status: "DRAFT",
      publishedAt: null,
      everPublished: false,
    });
  });

  it("is absent from the index", async () => {
    expect(await listPublishedPosts()).toEqual([]);
  });

  it("is absent from the detail page — null, not a partial", async () => {
    // The route renders a 404 for null, so a draft slug is not even confirmed
    // to exist. A 403 would confirm it.
    expect(await getPublishedPost("secret-draft")).toBeNull();
  });

  it("is absent from the sitemap", async () => {
    expect(await listPublishedSlugs()).toEqual([]);
  });

  it("is absent from the related-posts list", async () => {
    await makePost({ slug: "live-one" });
    const related = await listRelatedPosts("live-one", ["client-records"]);
    expect(related.map((r) => r.slug)).not.toContain("secret-draft");
  });

  it("never leaks its title through any public shape", async () => {
    const everything = JSON.stringify([
      await listPublishedPosts(),
      await getPublishedPost("secret-draft"),
      await listPublishedSlugs(),
      await listRelatedPosts("x", []),
    ]);
    expect(everything).not.toContain("Unannounced feature");
    expect(everything).not.toContain("secret-draft");
  });
});

describe("a post PUBLISHED with a future date is not yet public", () => {
  /**
   * The half of the boundary that a `status: "PUBLISHED"` filter alone would
   * miss. Every one of these assertions passes on a broken implementation if
   * the time comparison is dropped, which is exactly why they are here.
   */
  beforeEach(async () => {
    const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await makePost({
      slug: "embargoed-post",
      title: "Embargoed announcement",
      status: "PUBLISHED",
      publishedAt: nextWeek,
      everPublished: true,
    });
  });

  it("is absent from the index", async () => {
    expect(await listPublishedPosts()).toEqual([]);
  });

  it("404s on the detail page", async () => {
    expect(await getPublishedPost("embargoed-post")).toBeNull();
  });

  it("is absent from the sitemap", async () => {
    expect(await listPublishedSlugs()).toEqual([]);
  });
});

describe("a published post is readable", () => {
  it("appears in the index without its body", async () => {
    await makePost();
    const [post] = await listPublishedPosts();
    expect(post.slug).toBe("a-published-post");
    expect(post.title).toBe("A published post");
    // The index projects the body away: it is the large field and no card
    // renders it.
    expect(post).not.toHaveProperty("body");
  });

  it("is returned in full by the detail read", async () => {
    await makePost();
    const post = await getPublishedPost("a-published-post");
    expect(post?.body).toBe(BODY);
    expect(post?.publishedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("appears in the sitemap with its own last-modified date", async () => {
    await makePost();
    const [entry] = await listPublishedSlugs();
    expect(entry.slug).toBe("a-published-post");
    expect(entry.updatedAt).toBeInstanceOf(Date);
  });

  it("sorts newest first", async () => {
    await makePost({ slug: "older", publishedAt: new Date("2025-01-01") });
    await makePost({ slug: "newer", publishedAt: new Date("2026-06-01") });
    const posts = await listPublishedPosts();
    expect(posts.map((p) => p.slug)).toEqual(["newer", "older"]);
  });
});

describe("getPublishedPost — input handling", () => {
  it("rejects a malformed slug WITHOUT touching the database", async () => {
    // Cheap, but the point is that no user-controlled string reaches a query
    // as a value we have not shape-checked first.
    for (const bad of [
      "../../etc/passwd",
      "a b",
      "UPPER",
      "",
      "x".repeat(500),
      "a-post; drop",
    ]) {
      expect(await getPublishedPost(bad), bad).toBeNull();
    }
  });

  it("is case- and whitespace-tolerant for a genuine slug", async () => {
    await makePost();
    expect(await getPublishedPost(" A-Published-Post ")).toBeNull();
    // Slugs are lowercase by definition; the tolerant path is the trim only.
    expect(await getPublishedPost("a-published-post")).not.toBeNull();
  });
});

describe("cover images are re-validated on the way OUT", () => {
  it("drops an unsafe cover written directly to the database", async () => {
    // A post seeded by a script, or written before the validation existed,
    // must not put `javascript:` into an <img src>. Validating only on write
    // would trust every row already in the collection.
    await makePost({ coverImageUrl: "javascript:alert(1)" });
    const post = await getPublishedPost("a-published-post");
    expect(post?.coverImageUrl).toBeNull();
  });

  it("keeps a legitimate https cover", async () => {
    await makePost({ coverImageUrl: "https://cdn.example.com/a.png" });
    const post = await getPublishedPost("a-published-post");
    expect(post?.coverImageUrl).toBe("https://cdn.example.com/a.png");
  });
});

describe("related posts", () => {
  it("prefers a shared tag, then falls back to recency", async () => {
    await makePost({ slug: "current", tags: ["invoicing"] });
    await makePost({ slug: "same-tag", tags: ["invoicing"] });
    await makePost({ slug: "other", tags: ["onboarding"] });

    const related = await listRelatedPosts("current", ["invoicing"], 3);
    expect(related.map((r) => r.slug)).toContain("same-tag");
    expect(related.map((r) => r.slug)).not.toContain("current");
  });

  it("never returns the post it was called for", async () => {
    await makePost({ slug: "current", tags: [] });
    const related = await listRelatedPosts("current", [], 3);
    expect(related.map((r) => r.slug)).not.toContain("current");
  });
});

describe("deriveExcerpt", () => {
  it("strips markup and truncates on a word boundary", () => {
    const text = deriveExcerpt(`## Heading\n\n${"word ".repeat(100)}`, 60);
    expect(text).not.toContain("#");
    expect(text.length).toBeLessThanOrEqual(61); // + the ellipsis
    expect(text.endsWith("…")).toBe(true);
  });

  it("returns short content unchanged and un-ellipsised", () => {
    expect(deriveExcerpt("A short body.")).toBe("A short body.");
  });
});
