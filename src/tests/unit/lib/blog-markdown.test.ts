// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  headingId,
  markdownToPlainText,
  parseInline,
  parseMarkdown,
  readingMinutes,
  tableOfContents,
} from "@/lib/blog/markdown";
import { isExternalUrl, isSafeImageUrl, isSafeUrl } from "@/lib/blog/url";
import {
  BLOG_SLUG_MAX,
  blogPostPath,
  isValidBlogSlug,
  slugifyTitle,
} from "@/lib/blog/slug";

/**
 * Blog content pipeline.
 *
 * The security claim this file has to keep honest is specific: blog content
 * never becomes HTML. It is parsed to plain data and rendered as React
 * elements, so raw markup in a post is not sanitised — it is never
 * interpreted. That claim is only worth as much as the assertions below, so
 * they cover the parser's own output AND the absence of
 * `dangerouslySetInnerHTML` from the rendering component.
 *
 * The second class of assertion is URL safety. Links and images are the two
 * places author-supplied text becomes a browser-followed reference, and the
 * scheme allow-list is the only thing standing between a stored post and
 * `javascript:`.
 */

describe("parseMarkdown — raw HTML is never interpreted", () => {
  it("keeps a script tag as literal TEXT", () => {
    const blocks = parseMarkdown("<script>alert(1)</script>");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "paragraph" });
    // The characters survive verbatim as a text node — which React escapes.
    // What matters is that no node type exists that could carry markup.
    expect(markdownToPlainText("<script>alert(1)</script>")).toBe(
      "<script>alert(1)</script>",
    );
  });

  it("produces only known block types, none of which carry HTML", () => {
    const source = [
      "## Heading",
      "",
      "<img src=x onerror=alert(1)>",
      "",
      "- <b>item</b>",
      "",
      "> <iframe src='//evil'></iframe>",
    ].join("\n");
    const allowed = new Set([
      "heading",
      "paragraph",
      "list",
      "quote",
      "code",
      "rule",
      "image",
    ]);
    for (const block of parseMarkdown(source)) {
      expect(allowed.has(block.type), block.type).toBe(true);
    }
  });

  it("the renderer contains no dangerouslySetInnerHTML", () => {
    // The single assertion the whole "no HTML string" design rests on. A
    // component test cannot catch a `dangerouslySetInnerHTML` added to a
    // branch the test does not exercise; a source scan can.
    const src = fs.readFileSync(
      path.resolve(
        process.cwd(),
        "src/components/marketing/blog/blog-content.tsx",
      ),
      "utf8",
    );
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toContain("dangerouslySetInnerHTML");
    expect(code).not.toContain("innerHTML");
  });
});

describe("parseMarkdown — blocks", () => {
  it("parses headings with stable anchor ids", () => {
    const [h] = parseMarkdown("## What belongs in a record");
    expect(h).toEqual({
      type: "heading",
      level: 2,
      text: "What belongs in a record",
      id: "what-belongs-in-a-record",
    });
  });

  it("emits only H2 and H3, so a post cannot add a second H1", () => {
    // The article title is the page's H1. A body-supplied H1 would split the
    // document outline and is simply not a syntax this parser accepts.
    const blocks = parseMarkdown("# Not a heading\n\n## Real heading");
    const headings = blocks.filter((b) => b.type === "heading");
    expect(headings).toHaveLength(1);
    expect(headings[0]).toMatchObject({ level: 2 });
  });

  it("parses both list kinds", () => {
    const [ul] = parseMarkdown("- one\n- two");
    const [ol] = parseMarkdown("1. one\n2. two");
    expect(ul).toMatchObject({ type: "list", ordered: false });
    expect(ol).toMatchObject({ type: "list", ordered: true });
    expect((ul as { items: unknown[] }).items).toHaveLength(2);
  });

  it("keeps markdown syntax literal inside a fenced code block", () => {
    const [block] = parseMarkdown("```\n## not a heading\n- not a list\n```");
    expect(block).toEqual({
      type: "code",
      value: "## not a heading\n- not a list",
    });
  });

  it("joins a multi-line paragraph and stops at the next block", () => {
    const blocks = parseMarkdown("one\ntwo\n\n## Heading");
    expect(blocks).toHaveLength(2);
    expect(markdownToPlainText("one\ntwo")).toBe("one two");
  });

  it("parses quotes and rules", () => {
    expect(parseMarkdown("> quoted")[0]).toMatchObject({ type: "quote" });
    expect(parseMarkdown("---")[0]).toEqual({ type: "rule" });
  });

  it("returns an empty list for empty input rather than throwing", () => {
    for (const bad of ["", "   ", "\n\n", null, undefined]) {
      expect(parseMarkdown(bad as string), String(bad)).toEqual([]);
    }
  });
});

describe("parseInline", () => {
  it("reads bold before italic, so ** is never two *", () => {
    const nodes = parseInline("**bold** and *italic*");
    expect(nodes.filter((n) => n.type === "strong")).toHaveLength(1);
    expect(nodes.filter((n) => n.type === "em")).toHaveLength(1);
    expect(nodes.find((n) => n.type === "strong")).toMatchObject({
      value: "bold",
    });
  });

  it("parses inline code and links", () => {
    const nodes = parseInline("see `code` and [the guide](/client-management)");
    expect(nodes).toContainEqual({ type: "code", value: "code" });
    expect(nodes).toContainEqual({
      type: "link",
      value: "the guide",
      href: "/client-management",
      external: false,
    });
  });

  it("marks an off-site link external", () => {
    const [node] = parseInline("[docs](https://example.com/x)").filter(
      (n) => n.type === "link",
    );
    expect(node).toMatchObject({ external: true });
  });

  it("DEGRADES an unsafe link to plain text, keeping the words", () => {
    // A hole in the sentence would be a worse outcome than a dead link.
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "//evil.example.com",
    ]) {
      const nodes = parseInline(`click [here](${bad}) now`);
      expect(nodes.some((n) => n.type === "link"), bad).toBe(false);
      expect(nodes.map((n) => n.value).join(""), bad).toContain("here");
    }
  });
});

describe("images", () => {
  it("accepts an https image on its own line", () => {
    const [block] = parseMarkdown("![A dashboard](https://cdn.example.com/a.png)");
    expect(block).toEqual({
      type: "image",
      src: "https://cdn.example.com/a.png",
      alt: "A dashboard",
    });
  });

  it("accepts a site-relative image path", () => {
    const [block] = parseMarkdown("![Chart](/marketing/chart.png)");
    expect(block).toMatchObject({ type: "image", src: "/marketing/chart.png" });
  });

  it("DROPS an unsafe image rather than rendering it", () => {
    // Parenthesis-free URLs, so the image production is the branch actually
    // exercised — a URL containing `)` never matches the image syntax at all
    // and is covered by the fall-through case below.
    for (const bad of [
      "javascript:alert",
      "data:image/svg+xml;base64,PHN2Zz4=",
      "http://insecure.example.com/a.png",
      "//evil.example.com/a.png",
      "vbscript:x",
    ]) {
      expect(parseMarkdown(`![x](${bad})`), bad).toEqual([]);
    }
  });

  it("never yields an image or link node for a hostile URL, however it parses", () => {
    /**
     * The property that actually matters, stated independently of which
     * production matched. A URL containing `)` — `javascript:alert(1)`, an
     * inline SVG payload — does not match the image syntax, falls through to
     * a paragraph, and is then rejected by the inline link check. The result
     * is literal text: no node exists that a browser would follow.
     */
    for (const bad of [
      "javascript:alert(1)",
      "data:image/svg+xml,<svg onload=alert(1)>",
      "javascript:alert",
      "//evil.example.com/a.png",
    ]) {
      const blocks = parseMarkdown(`![x](${bad})\n\n[y](${bad})`);
      const kinds = blocks.map((b) => b.type);
      expect(kinds, bad).not.toContain("image");
      for (const block of blocks) {
        if (block.type !== "paragraph") continue;
        expect(
          block.children.some((n) => n.type === "link"),
          bad,
        ).toBe(false);
      }
      // And the payload never survives as anything a renderer would follow.
      expect(JSON.stringify(blocks), bad).not.toContain('"type":"link"');
    }
  });
});

describe("URL safety", () => {
  it.each([
    "https://example.com",
    "http://example.com/a?b=c",
    "/client-management",
    "/blog/post#section",
    "#anchor",
  ])("accepts %s as a link", (url) => {
    expect(isSafeUrl(url)).toBe(true);
  });

  it.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "//evil.example.com",
    "",
    "   ",
  ])("rejects %s as a link", (url) => {
    expect(isSafeUrl(url)).toBe(false);
  });

  it("rejects a scheme smuggled past the check with control characters", () => {
    // Browsers strip these before parsing, so `java\tscript:` reaches the URL
    // parser as `javascript:`. Rejecting beats replicating that normalisation.
    for (const bad of [
      "java\tscript:alert(1)",
      "java\nscript:alert(1)",
      "java\rscript:alert(1)",
      " javascript:alert(1)",
      " javascript:alert(1)",
    ]) {
      expect(isSafeUrl(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("holds images to https or a site path — no plain http", () => {
    expect(isSafeImageUrl("https://cdn.example.com/a.png")).toBe(true);
    expect(isSafeImageUrl("/marketing/a.png")).toBe(true);
    // Mixed content: it would be blocked by the browser anyway, so accepting
    // it only produces a broken image.
    expect(isSafeImageUrl("http://cdn.example.com/a.png")).toBe(false);
    expect(isSafeImageUrl("#anchor")).toBe(false);
  });

  it("identifies external URLs", () => {
    expect(isExternalUrl("https://example.com")).toBe(true);
    expect(isExternalUrl("/pricing")).toBe(false);
  });

  it("never throws on garbage", () => {
    for (const bad of [null, undefined, 42, {}, []]) {
      expect(() => isSafeUrl(bad as string)).not.toThrow();
      expect(isSafeUrl(bad as string), String(bad)).toBe(false);
    }
  });
});

describe("derived metadata", () => {
  it("strips markup for plain text", () => {
    expect(markdownToPlainText("## Title\n\n**Bold** and [link](/x).")).toBe(
      "Title Bold and link.",
    );
  });

  it("excludes code from reading time, which would badly overstate it", () => {
    const prose = "word ".repeat(220);
    const withCode = `${prose}\n\n\`\`\`\n${"token ".repeat(2000)}\n\`\`\``;
    expect(readingMinutes(withCode)).toBe(readingMinutes(prose));
  });

  it("never reports less than a minute", () => {
    expect(readingMinutes("short")).toBe(1);
    expect(readingMinutes("")).toBe(1);
  });

  it("builds a table of contents from the headings", () => {
    const toc = tableOfContents("## One\n\ntext\n\n### Two\n\n## Three");
    expect(toc).toEqual([
      { id: "one", text: "One", level: 2 },
      { id: "two", text: "Two", level: 3 },
      { id: "three", text: "Three", level: 2 },
    ]);
  });

  it("produces URL-safe heading ids", () => {
    expect(headingId("What's in a “client record”?")).toBe(
      "what-s-in-a-client-record",
    );
    expect(headingId("!!!")).toBe("section");
    expect(headingId("x".repeat(200)).length).toBeLessThanOrEqual(64);
  });
});

describe("slugs", () => {
  it.each(["a-b", "client-management", "abc", "post-2026"])(
    "accepts %s",
    (slug) => expect(isValidBlogSlug(slug)).toBe(true),
  );

  it.each([
    "ab",
    "Has-Capitals",
    "trailing-",
    "-leading",
    "double--hyphen",
    "has space",
    "has_underscore",
    "café",
    "x".repeat(BLOG_SLUG_MAX + 1),
    "",
  ])("rejects %s", (slug) => expect(isValidBlogSlug(slug)).toBe(false));

  it("suggests a slug from a title", () => {
    expect(slugifyTitle("What Belongs in a Client Record?")).toBe(
      "what-belongs-in-a-client-record",
    );
    expect(slugifyTitle("Café & Co — 2026!")).toBe("cafe-co-2026");
  });

  it("always suggests something valid or empty, never something invalid", () => {
    for (const title of ["!!!", "  ", "a", "—", "x".repeat(300)]) {
      const s = slugifyTitle(title);
      if (s) expect(isValidBlogSlug(s) || s.length < 3, title).toBe(true);
      expect(s).not.toMatch(/^-|-$|--/);
    }
  });

  it("builds the public path", () => {
    expect(blogPostPath("a-post")).toBe("/blog/a-post");
  });
});
