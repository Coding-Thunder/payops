// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  markdownToPlainText,
  parseMarkdown,
  readingMinutes,
} from "@/lib/blog/markdown";
import { isValidBlogSlug } from "@/lib/blog/slug";
import { BLOG_SEED_POSTS } from "@/server/content/blog-seed";

/**
 * Claim discipline for the seeded blog content.
 *
 * Same rule as `seo-claims.test.ts`, applied to prose: published marketing
 * content may not promise a capability the product does not have, and may not
 * manufacture evidence it does not possess.
 *
 * The second half is the one that matters most here. TraceTxn is a private
 * beta with no customers to quote and no measured outcomes to report, so a
 * statistic or a testimonial in an article would not be marketing licence —
 * it would be a fabrication published under the company's name. There is no
 * safe amount of it, so the assertions below are absolute rather than
 * thresholded.
 */

/**
 * Capabilities the product does NOT implement — kept in step with the
 * `UNIMPLEMENTED` list in `seo-claims.test.ts`, plus the ones an article is
 * more likely to drift into than a meta description.
 *
 * Delete an entry the day the feature ships. That is the signal the claim
 * became true.
 */
const UNIMPLEMENTED: [RegExp, string][] = [
  [/\bapprovals?\b/i, "there is no approvals model, service, route or UI"],
  // `\besign\b` on BOTH sides: "design" ends in "esign".
  [/e-?signature|\besign\b/i, "nothing signs documents"],
  [/\bsign-?off\b/i, "no sign-off state exists"],
  [/\btime[- ]tracking\b/i, "no timesheets, no timers"],
  [/\bproposals?\b(?!\s*(?:they|you|are|is))/i, "no proposal builder exists"],
  [/\bforecast/i, "no forecasting of any kind"],
  [/\bAI\b|\bmachine learning\b/i, "no AI features exist"],
  [/\banalytics dashboard\b|\breporting dashboard\b/i, "no dashboards"],
  [/\blead scoring\b|\bpipeline stages?\b/i, "TraceTxn has no sales pipeline"],
];

/**
 * Sentences that legitimately contain a word from `UNIMPLEMENTED`.
 *
 * The pattern list above is deliberately blunt: it matches a word anywhere in
 * a post, with no attempt to work out whether the sentence is CLAIMING the
 * capability or DENYING it. That bluntness is the point — a regex that tried
 * to parse intent would be the thing that eventually lets a real claim past.
 *
 * The cost is that honest copy trips it. An article comparing TraceTxn to a
 * CRM has to be able to say "there is no forecast", and saying so is the
 * opposite of a false claim; refusing the sentence would make the article less
 * accurate, not more.
 *
 * So exemptions are EXACT SENTENCES, listed here with a reason, rather than a
 * cleverer pattern. Adding one is a deliberate, reviewable act: a new mention
 * fails the test until a human writes it down, which is the property that a
 * negation-aware regex would quietly lose.
 */
const REVIEWED_MENTIONS: [string, string][] = [
  [
    "There is no pipeline, no forecast, no lead scoring.",
    "An explicit DENIAL that TraceTxn has these. Removing it would make the article less honest, not more.",
  ],
];

/**
 * Fabricated-evidence patterns. Each of these would be a claim about the
 * world that nobody at TraceTxn has measured.
 */
const FABRICATION: [RegExp, string][] = [
  [/\b\d{1,3}(\.\d+)?%/, "a percentage — no measured figure exists to cite"],
  [/\bstudies show\b|\bresearch shows\b|\bsurveys? found\b/i, "uncited research"],
  [/\b\d+x (faster|more|better|higher)\b/i, "an unmeasured multiplier"],
  [/\bour (customers|clients|users) (say|report|tell us)\b/i, "no customers yet"],
  [/\baverage (agency|freelancer|business) (saves|spends|loses)\b/i, "invented average"],
  [/\btrusted by\b|\bjoin \d+/i, "a social-proof claim with no basis"],
];

describe("every seed post is structurally publishable", () => {
  it.each(BLOG_SEED_POSTS.map((p) => [p.slug, p] as const))(
    "%s",
    (_slug, post) => {
      expect(isValidBlogSlug(post.slug)).toBe(true);
      expect(post.title.length).toBeGreaterThanOrEqual(8);
      expect(post.title.length).toBeLessThanOrEqual(200);
      expect(post.excerpt.length).toBeGreaterThan(40);
      expect(post.excerpt.length).toBeLessThanOrEqual(400);
      expect(post.authorName.trim()).not.toBe("");
      expect(post.tags.length).toBeGreaterThan(0);
      expect(post.tags.length).toBeLessThanOrEqual(8);
      for (const tag of post.tags) expect(tag).toMatch(/^[a-z0-9-]+$/);
      if (post.seoTitle) expect(post.seoTitle.length).toBeLessThanOrEqual(200);
      if (post.seoDescription) {
        expect(post.seoDescription.length).toBeLessThanOrEqual(400);
      }
    },
  );

  it("has no duplicate slugs", () => {
    const slugs = BLOG_SEED_POSTS.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("ships a meaningful amount of content, not stubs", () => {
    // A short post is worse than no post: it reads as an abandoned blog and
    // is exactly the thin content that thin-content penalties target.
    for (const post of BLOG_SEED_POSTS) {
      const words = markdownToPlainText(post.body).split(/\s+/).length;
      expect(words, `${post.slug} is ${words} words`).toBeGreaterThan(700);
      expect(readingMinutes(post.body)).toBeGreaterThanOrEqual(3);
    }
  });

  it("gives every post real structure — headings a reader can scan", () => {
    for (const post of BLOG_SEED_POSTS) {
      const headings = parseMarkdown(post.body).filter(
        (b) => b.type === "heading",
      );
      expect(headings.length, post.slug).toBeGreaterThanOrEqual(3);
    }
  });

  it("parses to known block types only — no raw HTML anywhere", () => {
    for (const post of BLOG_SEED_POSTS) {
      const blocks = parseMarkdown(post.body);
      expect(blocks.length, post.slug).toBeGreaterThan(5);
      expect(post.body).not.toMatch(/<script|<iframe|onerror=|javascript:/i);
    }
  });
});

describe("claim discipline", () => {
  it.each(BLOG_SEED_POSTS.map((p) => [p.slug, p] as const))(
    "%s promises nothing the product cannot do",
    (slug, post) => {
      let text = `${post.title} ${post.excerpt} ${post.seoTitle ?? ""} ${
        post.seoDescription ?? ""
      } ${post.body}`;
      for (const [sentence] of REVIEWED_MENTIONS) text = text.split(sentence).join(" ");
      for (const [pattern, why] of UNIMPLEMENTED) {
        expect(text, `${slug} matches ${pattern} — ${why}`).not.toMatch(pattern);
      }
    },
  );

  it.each(BLOG_SEED_POSTS.map((p) => [p.slug, p] as const))(
    "%s invents no evidence",
    (slug, post) => {
      const text = `${post.title} ${post.excerpt} ${post.body}`;
      for (const [pattern, why] of FABRICATION) {
        expect(text, `${slug} matches ${pattern} — ${why}`).not.toMatch(pattern);
      }
    },
  );

  it("keeps the exemption list honest — every entry still appears in a post", () => {
    // A stale exemption is a hole: it exempts nothing today and silently
    // covers a future sentence that happens to match. Deleting a post or
    // rewording a sentence must make this fail.
    const all = BLOG_SEED_POSTS.map((p) => p.body).join("\n");
    for (const [sentence, reason] of REVIEWED_MENTIONS) {
      expect(all, `stale exemption: "${sentence}" (${reason})`).toContain(
        sentence,
      );
    }
  });

  it("names no customer or testimonial", () => {
    // The product is a private beta. There is nobody to quote.
    for (const post of BLOG_SEED_POSTS) {
      expect(post.body, post.slug).not.toMatch(
        /["“][^"”]{20,}["”]\s*[—–-]\s*[A-Z]/,
      );
    }
  });
});

describe("SEO hygiene", () => {
  it("links internally without turning the article into a funnel", () => {
    // Every post should link into the cluster at least once — and a post that
    // is mostly links is a doorway page, which is the thing the spec rules
    // out. Two to six internal links is a real article that knows where it
    // sits on the site.
    for (const post of BLOG_SEED_POSTS) {
      const internal = [...post.body.matchAll(/\]\((\/[^)]*)\)/g)];
      expect(internal.length, `${post.slug} has no internal links`).toBeGreaterThan(0);
      expect(internal.length, `${post.slug} reads as a link farm`).toBeLessThan(8);
      for (const [, href] of internal) {
        expect(href, `${post.slug} links to a non-path`).toMatch(/^\/[a-z0-9/#-]*$/);
      }
    }
  });

  it("links only to routes that exist", () => {
    // A published article pointing at a 404 is worse than one that links
    // nowhere. These are the public marketing paths as of this test.
    const REAL_PATHS = new Set([
      "/",
      "/features",
      "/pricing",
      "/security",
      "/contact",
      "/waitlist",
      "/privacy",
      "/terms",
      "/dpa",
      "/refunds",
      "/blog",
      "/client-management",
      "/client-management-software",
      "/agency-client-management",
      "/client-communication-management",
      "/client-record-management",
    ]);
    for (const post of BLOG_SEED_POSTS) {
      for (const [, href] of post.body.matchAll(/\]\((\/[^)]*)\)/g)) {
        const path = href.split("#")[0].replace(/\/$/, "") || "/";
        expect(REAL_PATHS.has(path), `${post.slug} links to ${href}`).toBe(true);
      }
    }
  });

  it("keeps titles and descriptions inside what a SERP renders", () => {
    for (const post of BLOG_SEED_POSTS) {
      const title = post.seoTitle ?? post.title;
      expect(title.length, `${post.slug} title is ${title.length} chars`).toBeLessThanOrEqual(70);
      const desc = post.seoDescription ?? post.excerpt;
      expect(desc.length, `${post.slug} description is ${desc.length}`).toBeLessThanOrEqual(200);
      expect(desc.length).toBeGreaterThan(70);
    }
  });

  it("does not keyword-stuff the primary term", () => {
    // The failure mode the spec names explicitly. A term appearing on every
    // third line is the signature of copy written for a crawler.
    for (const post of BLOG_SEED_POSTS) {
      const words = markdownToPlainText(post.body).toLowerCase();
      const total = words.split(/\s+/).length;
      const hits = (words.match(/client management/g) ?? []).length;
      expect(
        hits / total,
        `${post.slug}: "client management" is ${hits}/${total} words`,
      ).toBeLessThan(0.01);
    }
  });

  it("gives each post a distinct title and excerpt", () => {
    const titles = BLOG_SEED_POSTS.map((p) => p.title.toLowerCase());
    const excerpts = BLOG_SEED_POSTS.map((p) => p.excerpt.toLowerCase());
    expect(new Set(titles).size).toBe(titles.length);
    expect(new Set(excerpts).size).toBe(excerpts.length);
  });
});
