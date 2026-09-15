/**
 * URL safety for author-supplied links and images.
 *
 * Blog content is written by admins, not by the public — but "only admins can
 * write it" is exactly the assumption that makes stored XSS expensive when it
 * turns out to be wrong (a compromised admin session, a future import tool, a
 * seed file edited by someone else). The content pipeline therefore never
 * trusts its input, and this is the choke point for anything that becomes an
 * `href` or a `src`.
 *
 * The rule is an ALLOW-LIST of schemes, not a denylist of dangerous ones.
 * `javascript:` is the obvious one, but `data:` can carry a whole HTML
 * document, `vbscript:` still executes in some engines, and a denylist has to
 * anticipate every future scheme. An allow-list of `http`, `https` and
 * site-relative paths cannot be outflanked that way.
 *
 * Note what this does NOT do: it never rewrites a URL to make it safe.
 * Sanitising by mutation ("strip the colon", "prepend https://") is how
 * bypasses are born. An unsafe URL is rejected outright and the caller
 * renders plain text instead of a link.
 */

/** Schemes permitted in blog content. Absolute URLs only. */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Whitespace and C0/C1 control characters.
 *
 * Browsers strip these before parsing a URL, which is the classic way to
 * smuggle a scheme past a naive check — `java\tscript:alert(1)` reaches
 * the parser as `javascript:`. Rejecting rather than stripping keeps this
 * function from having to replicate the browser's exact normalisation.
 */
const UNSAFE_URL_CHARS = /[\s\u0000-\u001f\u007f-\u009f]/;

/**
 * True when `url` is safe to place in an `href`.
 *
 * Accepts absolute http(s) URLs and site-relative paths (`/pricing`,
 * `/blog/x#section`). Rejects everything else, including protocol-relative
 * `//evil.com` — which looks relative, is not, and would inherit the page's
 * scheme to reach an attacker-controlled host.
 */
export function isSafeUrl(url: string | null | undefined): boolean {
  if (typeof url !== "string") return false;
  const raw = url.trim();
  if (!raw) return false;
  if (UNSAFE_URL_CHARS.test(raw)) return false;

  if (raw.startsWith("//")) return false; // protocol-relative: not relative
  if (raw.startsWith("/")) return true; // site-relative path
  if (raw.startsWith("#")) return true; // in-page anchor

  try {
    return ALLOWED_PROTOCOLS.has(new URL(raw).protocol);
  } catch {
    return false;
  }
}

/**
 * True when `url` is safe to place in an image `src`.
 *
 * Stricter than `isSafeUrl`: images must be absolute https, or a path under
 * `/` that this site serves. `http:` is excluded because a plain-http image
 * on an https page is blocked as mixed content anyway — accepting it would
 * only produce a broken image and a console error.
 */
export function isSafeImageUrl(url: string | null | undefined): boolean {
  if (!isSafeUrl(url)) return false;
  const raw = (url as string).trim();
  if (raw.startsWith("#")) return false; // an anchor is not an image
  if (raw.startsWith("/")) return true;
  try {
    return new URL(raw).protocol === "https:";
  } catch {
    return false;
  }
}

/** True when the URL points somewhere other than this site. */
export function isExternalUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}
