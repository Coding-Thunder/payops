import Link from "next/link";

import {
  parseMarkdown,
  type BlockNode,
  type InlineNode,
} from "@/lib/blog/markdown";

/**
 * Renders a post body.
 *
 * The security property of this component is what it does NOT contain:
 * `dangerouslySetInnerHTML` appears nowhere in it, and no HTML string is built
 * anywhere in the pipeline. Content arrives as an AST of plain data and leaves
 * as React elements, so every text node is escaped by React as a matter of
 * course. Raw HTML in a post is not sanitised — it is never interpreted, and
 * renders as visible text. See the header of `@/lib/blog/markdown`.
 *
 * Two smaller decisions worth keeping:
 *
 *   - Internal links use `next/link`; external links get
 *     `rel="noopener noreferrer"` and open in a new tab. `noopener` matters
 *     because an author-supplied link is not necessarily one we control.
 *   - Images render with explicit dimensions and `loading="lazy"`. Cover and
 *     in-body images are the main CLS risk on an article page, and a reserved
 *     aspect box is what stops the text reflowing when they arrive.
 */

function Inline({ nodes }: { nodes: InlineNode[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.type) {
          case "strong":
            return (
              <strong key={i} className="font-semibold text-foreground">
                {n.value}
              </strong>
            );
          case "em":
            return <em key={i}>{n.value}</em>;
          case "code":
            return (
              <code
                key={i}
                className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.9em]"
              >
                {n.value}
              </code>
            );
          case "link":
            // `href` was validated during parsing; an unsafe URL never becomes
            // a link node in the first place.
            return n.external ? (
              <a
                key={i}
                href={n.href}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-primary underline underline-offset-2"
              >
                {n.value}
              </a>
            ) : (
              <Link
                key={i}
                href={n.href}
                className="font-medium text-primary underline underline-offset-2"
              >
                {n.value}
              </Link>
            );
          default:
            return <span key={i}>{n.value}</span>;
        }
      })}
    </>
  );
}

function Block({ node }: { node: BlockNode }) {
  switch (node.type) {
    case "heading": {
      const Tag = node.level === 2 ? "h2" : "h3";
      return (
        <Tag
          id={node.id}
          className={
            node.level === 2
              ? "mt-12 scroll-mt-24 font-display text-[24px] font-semibold tracking-tight text-foreground"
              : "mt-8 scroll-mt-24 font-display text-[18px] font-semibold tracking-tight text-foreground"
          }
        >
          {node.text}
        </Tag>
      );
    }
    case "paragraph":
      return (
        <p className="mt-5 text-[15.5px] leading-[1.75] text-muted-foreground">
          <Inline nodes={node.children} />
        </p>
      );
    case "list":
      return node.ordered ? (
        <ol className="mt-5 list-decimal space-y-2 pl-6 text-[15.5px] leading-[1.75] text-muted-foreground">
          {node.items.map((item, i) => (
            <li key={i}>
              <Inline nodes={item} />
            </li>
          ))}
        </ol>
      ) : (
        <ul className="mt-5 list-disc space-y-2 pl-6 text-[15.5px] leading-[1.75] text-muted-foreground">
          {node.items.map((item, i) => (
            <li key={i}>
              <Inline nodes={item} />
            </li>
          ))}
        </ul>
      );
    case "quote":
      return (
        <blockquote className="mt-6 border-l-2 border-primary/30 pl-5 text-[15.5px] leading-[1.75] text-foreground/80 italic">
          <Inline nodes={node.children} />
        </blockquote>
      );
    case "code":
      return (
        <pre className="mt-6 overflow-x-auto rounded-xl border border-border bg-muted/50 p-4 text-[13px] leading-relaxed">
          <code className="font-mono">{node.value}</code>
        </pre>
      );
    case "rule":
      return <hr className="mt-10 border-border" />;
    case "image":
      return (
        <figure className="mt-8">
          {/*
            A plain <img>, not next/image: the src is author-supplied and may
            point at any https host, which next/image would refuse unless that
            host were pre-registered in `images.remotePatterns`. Explicit
            width/height plus an aspect box reserve the space so the article
            text does not reflow when the image loads.
          */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={node.src}
            alt={node.alt}
            width={1200}
            height={675}
            loading="lazy"
            decoding="async"
            className="aspect-[16/9] w-full rounded-xl border border-border object-cover"
          />
          {node.alt ? (
            <figcaption className="mt-2 text-center text-[12.5px] text-muted-foreground">
              {node.alt}
            </figcaption>
          ) : null}
        </figure>
      );
    default:
      return null;
  }
}

export function BlogContent({ body }: { body: string }) {
  const blocks = parseMarkdown(body);
  return (
    <div>
      {blocks.map((node, i) => (
        <Block key={i} node={node} />
      ))}
    </div>
  );
}
