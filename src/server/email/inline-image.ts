import "server-only";

import { promises as fs } from "node:fs";
import path from "node:path";

import { logger } from "@/lib/logger";
import {
  assetIdFromUrl,
  getAsset,
  isAssetUrl,
} from "@/server/storage/asset-store";

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
 *
 * TWO KINDS OF LOGO, TWO STORES. A logo that ships with the repo really is a
 * file under `public/` ("/providers/sixt.svg"). A logo an OPERATOR uploaded
 * is not a file at all: its bytes live in the GridFS asset bucket and are
 * served by the dynamic `/api/assets/<id>` route. Treating the second as a
 * public path asks the filesystem for `public/api/assets/<id>`, which has
 * never existed anywhere — that is the `ENOENT .../public/api/assets/<id>`
 * seen in production. Asset URLs are therefore resolved through the asset
 * store, not `fs`.
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

  // Operator-uploaded asset: read the bytes from the store that holds them.
  // Checked before any path handling, and also after the http(s) branch
  // below, because the stored value may be either "/api/assets/<id>" or an
  // absolute URL on our own host pointing at the same route.
  const assetUri = await inlineStoredAsset(src);
  if (assetUri !== undefined) return assetUri;

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
      const fromUrl = await inlineStoredAsset(publicPath);
      if (fromUrl !== undefined) return fromUrl;
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
 * Resolve an `/api/assets/<id>` URL from the GridFS asset store.
 *
 * Returns `undefined` when `src` is not an asset URL at all, so the caller
 * can tell "not mine" from "mine, and it failed" (`null`) — a missing asset
 * must NOT fall through to a filesystem read that is guaranteed to ENOENT.
 *
 * One Mongo read per distinct asset per process, memoised in the same cache
 * as the file-backed logos, so a send does not re-fetch bytes it already
 * has and the common case costs no query at all.
 */
async function inlineStoredAsset(
  src: string,
): Promise<string | null | undefined> {
  // Anything under /api/assets/ belongs to the store, VALID OR NOT. A
  // malformed id answered `undefined` here once, which handed the value back
  // to the filesystem branch and produced the same misleading
  // "ENOENT public/api/assets/..." for a URL that was never a file.
  if (!isAssetUrl(src)) return undefined;
  const assetId = assetIdFromUrl(src);
  if (!assetId) {
    logger.warn("email.image_asset_id_invalid", { src });
    return null;
  }

  const cacheKey = `asset:${assetId}`;
  if (cacheNegative.has(cacheKey)) return null;
  const cached = dataUriCache.get(cacheKey);
  if (cached) return cached;

  try {
    const asset = await getAsset(assetId);
    if (!asset) {
      // The owning document points at an asset that is no longer in the
      // bucket. Nothing to embed; the caller ships the original src.
      cacheNegative.add(cacheKey);
      logger.warn("email.image_asset_missing", { assetId });
      return null;
    }
    const dataUri = `data:${asset.contentType};base64,${Buffer.from(
      asset.buffer,
    ).toString("base64")}`;
    dataUriCache.set(cacheKey, dataUri);
    return dataUri;
  } catch (err) {
    cacheNegative.add(cacheKey);
    logger.warn("email.image_asset_read_failed", {
      assetId,
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
