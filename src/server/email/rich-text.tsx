import { Link, Text } from "@react-email/components";
import * as React from "react";

import { COLOR, SPACE, typeStyle } from "./components/tokens";

/**
 * Render an operator-written email body.
 *
 * The body is PLAIN TEXT, never HTML. Operators type into a textarea and
 * the only markup they can produce is a link — either a bare URL or the
 * `[label](url)` form the composer's "Insert link" writes. Everything
 * else stays literal, and because this returns React elements rather
 * than a string, escaping is React's job and injection isn't possible.
 *
 * That constraint is deliberate: this text becomes an email that goes to
 * someone else's inbox from the tenant's domain. A rich-text editor that
 * emits HTML would put arbitrary markup on that path for no product gain
 * — an agency writing a project update needs paragraphs and links.
 */

/** `[label](https://…)` — the form "Insert link" writes into the body. */
const MARKDOWN_LINK = /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]{1,2000})\)/g;
/** A bare URL an operator pasted. */
const BARE_URL = /(https?:\/\/[^\s<>()[\]]{1,2000})/g;

const linkStyle: React.CSSProperties = {
  color: COLOR.link,
  textDecoration: "underline",
};

/** One paragraph's worth of text → React nodes with links live. */
export function linkifyText(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  let key = 0;

  const md = new RegExp(MARKDOWN_LINK.source, "g");
  let match: RegExpExecArray | null;
  while ((match = md.exec(text)) !== null) {
    if (match.index > cursor) {
      nodes.push(
        ...linkifyBareUrls(text.slice(cursor, match.index), () => key++),
      );
    }
    nodes.push(
      <Link key={`md-${key++}`} href={match[2]} style={linkStyle}>
        {match[1]}
      </Link>,
    );
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) {
    nodes.push(...linkifyBareUrls(text.slice(cursor), () => key++));
  }
  return nodes;
}

function linkifyBareUrls(
  text: string,
  nextKey: () => number,
): React.ReactNode[] {
  const parts = text.split(BARE_URL);
  return parts.map((part) =>
    /^https?:\/\//.test(part) ? (
      <Link key={`url-${nextKey()}`} href={part} style={linkStyle}>
        {part}
      </Link>
    ) : (
      <React.Fragment key={`t-${nextKey()}`}>{part}</React.Fragment>
    ),
  );
}

/**
 * Split a body into paragraphs on blank lines and render each one.
 * Single newlines inside a paragraph are preserved via `pre-wrap`, so a
 * hand-formatted list keeps its shape without needing list syntax.
 */
export function renderEmailBody(body: string): React.ReactElement[] {
  return body
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((para) => para.trim())
    .filter(Boolean)
    .map((para, i) => (
      <Text
        key={i}
        style={{
          ...typeStyle("body"),
          margin: 0,
          marginTop: i === 0 ? 0 : SPACE.md,
          color: COLOR.textPrimary,
          whiteSpace: "pre-wrap",
        }}
      >
        {linkifyText(para)}
      </Text>
    ));
}
