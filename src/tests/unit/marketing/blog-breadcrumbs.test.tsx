import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: {
    server: {},
    public: {
      NEXT_PUBLIC_APP_NAME: "TraceTxn",
      NEXT_PUBLIC_APP_URL: "https://tracetxn.test",
    },
  },
}));

// The shell pulls in the marketing chrome; stub it so this test is about the
// breadcrumb data and nothing else.
vi.mock("@/components/marketing/brand-nav", () => ({ BrandNav: () => null }));
vi.mock("@/components/marketing/brand-footer", () => ({ BrandFooter: () => null }));
vi.mock("@/components/marketing/brand-cta-strip", () => ({ BrandCtaStrip: () => null }));

/**
 * BreadcrumbList correctness for the blog.
 *
 * The defect this pins: `Crumb.href` was optional "because the last crumb is
 * the current page", and the JSON-LD builder fell back to `/blog` whenever it
 * was missing. Every article therefore emitted positions 2 AND 3 with the
 * identical `/blog` URL — a trail that does not identify the page it is on,
 * which Google reports as a duplicate-URL breadcrumb.
 *
 * `href` is now required by the type, so the original bug is unrepresentable;
 * these assertions cover the behaviour the type cannot express.
 */

async function renderShell(crumbs: unknown) {
  const { BlogShell } = await import("@/components/marketing/blog/blog-shell");
  return renderToStaticMarkup(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    <BlogShell crumbs={crumbs as any}>
      <p>body</p>
    </BlogShell>,
  );
}

function breadcrumbFrom(html: string) {
  const blocks = [
    ...html.matchAll(
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g,
    ),
  ].map((m) => JSON.parse(m[1].replace(/\\u003c/g, "<")));
  return blocks.find((b) => b["@type"] === "BreadcrumbList");
}

const ARTICLE_CRUMBS = [
  { label: "Home", href: "/" },
  { label: "Blog", href: "/blog" },
  {
    label: "What belongs in a client record",
    href: "/blog/what-belongs-in-a-client-record",
    current: true,
  },
];

describe("article BreadcrumbList", () => {
  it("gives every position its own URL — no duplicates", async () => {
    const crumb = breadcrumbFrom(await renderShell(ARTICLE_CRUMBS));
    const items = crumb.itemListElement.map(
      (i: { item: string }) => i.item,
    );
    expect(items).toEqual([
      "https://tracetxn.test/",
      "https://tracetxn.test/blog",
      "https://tracetxn.test/blog/what-belongs-in-a-client-record",
    ]);
    // The exact regression: positions 2 and 3 must not collide.
    expect(new Set(items).size).toBe(items.length);
  });

  it("ends on the ARTICLE, not the index", async () => {
    const crumb = breadcrumbFrom(await renderShell(ARTICLE_CRUMBS));
    const last = crumb.itemListElement.at(-1);
    expect(last.item).toBe(
      "https://tracetxn.test/blog/what-belongs-in-a-client-record",
    );
    expect(last.item).not.toBe("https://tracetxn.test/blog");
    expect(last.name).toBe("What belongs in a client record");
  });

  it("numbers positions from 1, contiguously", async () => {
    const crumb = breadcrumbFrom(await renderShell(ARTICLE_CRUMBS));
    expect(crumb.itemListElement.map((i: { position: number }) => i.position)).toEqual([1, 2, 3]);
  });

  it("is valid BreadcrumbList JSON-LD", async () => {
    const crumb = breadcrumbFrom(await renderShell(ARTICLE_CRUMBS));
    expect(crumb["@context"]).toBe("https://schema.org");
    expect(crumb["@type"]).toBe("BreadcrumbList");
    for (const item of crumb.itemListElement) {
      expect(item["@type"]).toBe("ListItem");
      expect(typeof item.name).toBe("string");
      expect(item.name.length).toBeGreaterThan(0);
      // Absolute URLs only — a relative `item` is invalid here.
      expect(() => new URL(item.item)).not.toThrow();
    }
  });

  it("renders the visible trail to match, with the current page unlinked", async () => {
    const html = await renderShell(ARTICLE_CRUMBS);
    // The markup must not claim a trail the reader does not see.
    expect(html).toContain('href="/"');
    expect(html).toContain('href="/blog"');
    expect(html).toContain('aria-current="page"');
    // The current page is named, not linked.
    expect(html).not.toContain('href="/blog/what-belongs-in-a-client-record"');
    expect(html).toContain("What belongs in a client record");
  });

  it("the index page's own trail ends on /blog", async () => {
    const crumb = breadcrumbFrom(
      await renderShell([
        { label: "Home", href: "/" },
        { label: "Blog", href: "/blog", current: true },
      ]),
    );
    expect(crumb.itemListElement.map((i: { item: string }) => i.item)).toEqual([
      "https://tracetxn.test/",
      "https://tracetxn.test/blog",
    ]);
  });

  it("a crumb with no href must NOT silently become the /blog index", async () => {
    /**
     * THE ACTUAL REGRESSION. The original bug was not bad data — it was the
     * builder quietly substituting `BLOG_INDEX_PATH` for a missing `href`,
     * which made the last crumb of every article point at the index.
     *
     * `href` is required by the type now, so this feeds a deliberately
     * malformed crumb past the compiler to prove the FALLBACK IS GONE. If
     * someone reintroduces `c.href ?? BLOG_INDEX_PATH`, this fails.
     */
    let html: string | null = null;
    let threw = false;
    try {
      html = await renderShell([
        { label: "Home", href: "/" },
        { label: "Blog", href: "/blog" },
        { label: "Article with a missing href" }, // no href, on purpose
      ]);
    } catch {
      // Throwing is the CORRECT outcome: a breadcrumb that cannot name its
      // own page is a bug in the caller, and failing loudly in development
      // beats shipping structured data that points at the wrong URL.
      threw = true;
    }

    if (!threw) {
      const items = breadcrumbFrom(html as string).itemListElement.map(
        (i: { item: string }) => i.item,
      );
      expect(
        items[2],
        "a missing href silently resolved to the blog index — the original bug",
      ).not.toBe("https://tracetxn.test/blog");
      expect(new Set(items).size, "positions must stay distinct").toBe(3);
    }
    // And directly: the builder must contain no fallback at all. With every
    // call site correct the fallback would never fire, so a behavioural test
    // alone cannot see it — only reading the source can.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const shell = fs.readFileSync(
      path.join(process.cwd(), "src/components/marketing/blog/blog-shell.tsx"),
      "utf8",
    );
    const builder = shell.slice(
      shell.indexOf("itemListElement:"),
      shell.indexOf("};", shell.indexOf("itemListElement:")),
    );
    expect(builder).toContain("absoluteUrl(c.href)");
    expect(
      builder,
      "a default for a missing crumb href is what produced the duplicate /blog URL",
    ).not.toMatch(/c\.href\s*(\?\?|\|\|)/);
  });

  it("every real call site supplies an href for every crumb", async () => {
    /**
     * The type makes the omission a compile error, but only for code that is
     * type-checked as written — a spread or a cast slips past. This reads the
     * two actual call sites and asserts each crumb object carries an href,
     * which is the property that was violated in production.
     */
    const fs = await import("node:fs");
    const path = await import("node:path");
    for (const rel of ["src/app/blog/page.tsx", "src/app/blog/[slug]/page.tsx"]) {
      const src = fs.readFileSync(path.join(process.cwd(), rel), "utf8");
      const block = src.slice(src.indexOf("crumbs={["), src.indexOf("]}", src.indexOf("crumbs={[")));
      const crumbs = [...block.matchAll(/\{[^{}]*label:[^{}]*\}/g)].map((m) => m[0]);
      expect(crumbs.length, `${rel}: no crumbs parsed`).toBeGreaterThanOrEqual(2);
      for (const c of crumbs) {
        expect(c, `${rel}: crumb without href -> ${c}`).toContain("href:");
      }
    }
  });

  it("escapes a hostile crumb label so it cannot end the script block", async () => {
    const html = await renderShell([
      { label: "Home", href: "/" },
      { label: "Blog", href: "/blog" },
      { label: 'Title with </script><script>alert(1)</script>', href: "/blog/x", current: true },
    ]);
    const raw = [
      ...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g),
    ].map((m) => m[1]);
    for (const block of raw) {
      expect(block).not.toContain("</script>");
      expect(block).not.toContain("<");
    }
    // And it still parses.
    expect(breadcrumbFrom(html)["@type"]).toBe("BreadcrumbList");
  });
});
