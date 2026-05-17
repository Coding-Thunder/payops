import "server-only";

import { promises as fs } from "node:fs";
import path from "node:path";

import { logger } from "@/lib/logger";

/**
 * Email image inliner.
 *
 * Email clients (Gmail, Outlook, Apple Mail) fetch `<img src>` URLs through
 * a proxy that runs on the public internet — `http://localhost:3000/...`
 * resolves to *their* server, not yours, so the image silently fails in
 * dev and in any deploy without a publicly reachable APP_URL.
 *
 * Inlining as a base64 data URI sidesteps that entirely: the bytes ship
 * inside the HTML payload, no proxy fetch required. This matches how the
 * Stripe lock / check icons in the template are already shipped.
 *
 * Trade-off: data URIs add ~33% to the email size (base64). Provider logos
 * are typically <30 KB, so the payload is still well under the 102 KB
 * threshold where Gmail starts clipping messages.
 */

const MIME_BY_EXT: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

const dataUriCache = new Map<string, string>();
const cacheNegative = new Set<string>();

const PUBLIC_DIR = path.join(process.cwd(), "public");

/**
 * Resolve an `/something.png` public-path or an `http(s)://` URL into a
 * data URI suitable for `<img src=...>`. Returns `null` if the file can't
 * be read or the URL is remote and untrusted (we never fetch arbitrary
 * URLs from the server). Callers should fall back to the original src.
 *
 * Inputs supported:
 *   "/providers/sixt.svg"                 → data:image/svg+xml;base64,...
 *   "http://localhost:3000/providers/x"   → data:image/png;base64,...  (treated as /providers/x)
 *   "https://your.app/uploads/y.png"      → null  (we don't proxy-fetch)
 *   "data:image/png;base64,..."           → returned as-is
 */
export async function inlinePublicImage(
  src: string | null | undefined,
): Promise<string | null> {
  if (!src) return null;
  if (src.startsWith("data:")) return src;

  // Normalize to a /-rooted public path. http(s) URLs that point at our
  // own host get their pathname extracted; everything else is rejected.
  let publicPath = src;
  if (/^https?:\/\//i.test(src)) {
    try {
      const url = new URL(src);
      // Localhost / 127.0.0.1 / 0.0.0.0 always treated as "this server".
      // For remote hosts we don't fetch — return null and let the caller
      // ship the absolute URL (where it may or may not work in email).
      const isLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/i.test(
        url.hostname,
      );
      if (!isLocal) return null;
      publicPath = url.pathname;
    } catch {
      return null;
    }
  }
  if (!publicPath.startsWith("/")) publicPath = `/${publicPath}`;

  if (cacheNegative.has(publicPath)) return null;
  const cached = dataUriCache.get(publicPath);
  if (cached) return cached;

  // Path-traversal guard — keep callers inside public/.
  const resolved = path.normalize(path.join(PUBLIC_DIR, publicPath));
  if (!resolved.startsWith(PUBLIC_DIR + path.sep) && resolved !== PUBLIC_DIR) {
    cacheNegative.add(publicPath);
    return null;
  }

  try {
    const bytes = await fs.readFile(resolved);
    const ext = path.extname(resolved).toLowerCase();
    const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";
    const dataUri = `data:${mime};base64,${bytes.toString("base64")}`;
    dataUriCache.set(publicPath, dataUri);
    return dataUri;
  } catch (err) {
    cacheNegative.add(publicPath);
    logger.warn("email.image_inline_failed", {
      path: publicPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Test-only: drop the in-memory cache. The cache survives the process
 * lifetime so file edits in dev won't be picked up without a restart;
 * tests call this between assertions.
 */
export function _clearInlineImageCache(): void {
  dataUriCache.clear();
  cacheNegative.clear();
}
