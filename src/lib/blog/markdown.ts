/**
 * A small Markdown subset, parsed to a typed AST.
 *
 * ── Why not a Markdown library ───────────────────────────────────────────
 *
 * Every mainstream option (marked, markdown-it, remark-html) produces an HTML
 * STRING, which a React app can only render through `dangerouslySetInnerHTML`.
 * That single call is the entire attack surface: the renderer's own escaping
 * is then the only thing standing between stored content and script execution,
 * and each of those libraries ships raw-HTML passthrough enabled by default.
 * Turning it off correctly, and keeping it off across upgrades, is a standing
 * obligation.
 *
 * So this parser emits an AST of plain data instead. `<BlogContent>` maps it
 * to React elements, React escapes every text node as a matter of course, and
 * `dangerouslySetInnerHTML` appears nowhere in the blog pipeline. Raw HTML in
 * the source is not "sanitised" — it is never interpreted, and ends up on the
 * page as visible text. A `<script>` tag in a post renders as the literal
 * characters `<script>`.
 *
 * The cost is a deliberately small feature set. That is the right trade for
 * marketing content: headings, paragraphs, lists, quotes, code, links, images
 * and emphasis cover what these posts need, and anything richer belongs in a
 * component rather than in author-supplied text.
 *
 * ── The subset ───────────────────────────────────────────────────────────
 *
 *   ## H2, ### H3          headings (H1 is the page title; a post never
 *                          renders a second one — it splits the outline)
 *   paragraph text         blank-line separated
 *   - item / 1. item       unordered and ordered lists
 *   > quote                blockquote
 *   ```code```             fenced code block
 *   ---                    horizontal rule
 *   ![alt](src)            image, on its own line
 *   **bold** *italic*      inline emphasis
 *   `code`                 inline code
 *   [text](url)            link, URL-validated at render time
 */

import { isSafeImageUrl, isSafeUrl } from "./url";

/* ─── AST ──────────────────────────────────────────────────────────────── */

export type InlineNode =
  | { type: "text"; value: string }
  | { type: "strong"; value: string }
  | { type: "em"; value: string }
  | { type: "code"; value: string }
  /** `href` is guaranteed safe: an unsafe URL degrades to a `text` node. */
  | { type: "link"; value: string; href: string; external: boolean };

export type BlockNode =
  | { type: "heading"; level: 2 | 3; text: string; id: string }
  | { type: "paragraph"; children: InlineNode[] }
  | { type: "list"; ordered: boolean; items: InlineNode[][] }
  | { type: "quote"; children: InlineNode[] }
  | { type: "code"; value: string }
  | { type: "rule" }
  | { type: "image"; src: string; alt: string };

/* ─── Inline ───────────────────────────────────────────────────────────── */

/**
 * One pass over the four inline forms, longest-delimiter first so `**bold**`
 * is never mis-read as two `*italic*` markers.
 *
 * Order within the alternation is the whole correctness story here; the groups
 * are: inline code, bold, italic, link.
 */
const INLINE_RE =
  /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\(([^)\s]+)\)/g;

export function parseInline(input: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;

  const pushText = (value: string) => {
    if (value) nodes.push({ type: "text", value });
  };

  while ((m = INLINE_RE.exec(input)) !== null) {
    pushText(input.slice(last, m.index));
    const [, code, strong, em, linkText, href] = m;

    if (code !== undefined) nodes.push({ type: "code", value: code });
    else if (strong !== undefined) nodes.push({ type: "strong", value: strong });
    else if (em !== undefined) nodes.push({ type: "em", value: em });
    else if (linkText !== undefined && href !== undefined) {
      // An unsafe href does not throw and does not silently vanish: the link
      // TEXT is preserved as plain text, so a bad URL degrades to readable
      // content rather than to a hole in the sentence.
      if (isSafeUrl(href)) {
        nodes.push({
          type: "link",
          value: linkText,
          href: href.trim(),
          external: /^https?:\/\//i.test(href.trim()),
        });
      } else {
        pushText(linkText);
      }
    }
    last = m.index + m[0].length;
  }
  pushText(input.slice(last));
  return nodes;
}

/* ─── Headings ─────────────────────────────────────────────────────────── */

/**
 * A stable anchor id for a heading, so a post's sections are linkable and the
 * table of contents can point at them.
 *
 * ASCII-only by construction: anything outside `[a-z0-9-]` becomes a hyphen.
 * That keeps ids usable in a URL fragment without percent-encoding.
 */
export function headingId(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "section";
}

/* ─── Blocks ───────────────────────────────────────────────────────────── */

/** Hard ceiling on a single post, mirrored by the model and the admin form. */
export const MAX_BODY_LENGTH = 100_000;

/**
 * Parse a Markdown document into blocks.
 *
 * Line-oriented and single-pass. Unknown syntax is not an error — it falls
 * through to a paragraph, so a post never fails to render because of a typo.
 */
export function parseMarkdown(input: string): BlockNode[] {
  if (typeof input !== "string" || !input.trim()) return [];
  const lines = input.slice(0, MAX_BODY_LENGTH).replace(/\r\n?/g, "\n").split("\n");
  const blocks: BlockNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    // Fenced code. Consumes verbatim until the closing fence or EOF, so a
    // Markdown-looking line inside a code block stays literal.
    if (trimmed.startsWith("```")) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // closing fence (or EOF, harmlessly)
      blocks.push({ type: "code", value: body.join("\n") });
      continue;
    }

    if (/^---+$/.test(trimmed)) {
      blocks.push({ type: "rule" });
      i += 1;
      continue;
    }

    const heading = /^(#{2,3})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const text = heading[2].trim();
      blocks.push({
        type: "heading",
        level: heading[1].length === 2 ? 2 : 3,
        text,
        id: headingId(text),
      });
      i += 1;
      continue;
    }

    // A standalone image. Only matched on its own line — an image inside a
    // sentence would be a layout problem, not a feature.
    const image = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(trimmed);
    if (image) {
      const [, alt, src] = image;
      // An unsafe src drops the block entirely rather than rendering a broken
      // or attacker-chosen image.
      if (isSafeImageUrl(src)) {
        blocks.push({ type: "image", src: src.trim(), alt: alt.trim() });
      }
      i += 1;
      continue;
    }

    if (trimmed.startsWith(">")) {
      const body: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        body.push(lines[i].trim().replace(/^>\s?/, ""));
        i += 1;
      }
      blocks.push({ type: "quote", children: parseInline(body.join(" ")) });
      continue;
    }

    const bullet = /^[-*]\s+/;
    const numbered = /^\d+\.\s+/;
    if (bullet.test(trimmed) || numbered.test(trimmed)) {
      const ordered = numbered.test(trimmed);
      const re = ordered ? numbered : bullet;
      const items: InlineNode[][] = [];
      while (i < lines.length && re.test(lines[i].trim())) {
        items.push(parseInline(lines[i].trim().replace(re, "")));
        i += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    // Paragraph: everything until a blank line or the start of another block.
    const body: string[] = [];
    while (i < lines.length && lines[i].trim()) {
      const t = lines[i].trim();
      if (
        t.startsWith("```") ||
        t.startsWith(">") ||
        /^(#{2,3})\s+/.test(t) ||
        /^---+$/.test(t) ||
        bullet.test(t) ||
        numbered.test(t)
      ) {
        break;
      }
      body.push(t);
      i += 1;
    }
    if (body.length) {
      blocks.push({ type: "paragraph", children: parseInline(body.join(" ")) });
    }
  }

  return blocks;
}

/* ─── Derived metadata ─────────────────────────────────────────────────── */

/** Plain text of a document, for excerpts and reading time. */
export function markdownToPlainText(input: string): string {
  return parseMarkdown(input)
    .map((b) => {
      switch (b.type) {
        case "heading":
          return b.text;
        case "paragraph":
        case "quote":
          return b.children.map((n) => n.value).join("");
        case "list":
          return b.items
            .map((item) => item.map((n) => n.value).join(""))
            .join(" ");
        default:
          // Code and images contribute nothing readable to a summary, and
          // counting code toward reading time would badly overstate it.
          return "";
      }
    })
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Words per minute for reading-time estimates. Conservative on purpose. */
const WPM = 220;

export function readingMinutes(input: string): number {
  const words = markdownToPlainText(input).split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / WPM));
}

/** The H2/H3 outline, for an in-page table of contents. */
export function tableOfContents(
  input: string,
): { id: string; text: string; level: 2 | 3 }[] {
  return parseMarkdown(input)
    .filter((b): b is Extract<BlockNode, { type: "heading" }> => b.type === "heading")
    .map(({ id, text, level }) => ({ id, text, level }));
}
