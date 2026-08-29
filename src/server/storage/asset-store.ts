import "server-only";

import { GridFSBucket, ObjectId } from "mongodb";

import { connectMongo } from "@/server/db/mongoose";

/**
 * Durable storage for operator-uploaded binary assets (provider logos,
 * branding marks).
 *
 * WHY THIS EXISTS — the bug it fixes:
 *
 * Uploads previously went to `public/providers/` and `public/branding/` via
 * `fs.writeFile`, and the returned path was stored on the document. That
 * cannot work on this deployment and never did:
 *
 *   - Next serves `public/` out of the BUILD ARTIFACT. A file written at
 *     runtime is not in that artifact, so the request 404s.
 *   - DigitalOcean App Platform rebuilds the container from its image on
 *     every deploy, so anything written to the container filesystem is
 *     destroyed on the next push.
 *   - With more than one instance, the file only ever exists on whichever
 *     instance happened to serve the upload.
 *
 * The database record was always correct; the bytes simply were not there.
 * Verified in production: every logo committed to the repo returned 200,
 * while every runtime-uploaded one (`avis-563c9c0b.jpg`, `sixt-ace37dd4.jpg`)
 * returned 404.
 *
 * WHY GRIDFS, and not a second storage system: the bytes go in the database
 * that is already connected, already backed up, and already the source of
 * truth for the record that references them. No new service, no new
 * credentials, no new failure mode, and it survives redeploys and scales
 * across instances for free. It also matches where the sibling product in
 * this codebase moved its file bytes.
 *
 * Assets are immutable: an upload always creates a NEW id and the caller
 * repoints the document at it. Nothing is overwritten in place, so a stale
 * page or a cached receipt that still references the old id keeps resolving
 * until the old asset is explicitly deleted.
 */

const BUCKET_NAME = "uploads";

/**
 * Image types accepted for upload.
 *
 * SVG IS DELIBERATELY ABSENT and must stay that way. An SVG can carry inline
 * <script>, and these bytes are served back from our own origin — allowing
 * it would turn the provider logo upload into a stored-XSS sink against the
 * admin console. This mirrors the allowlist the previous filesystem
 * implementation enforced, for exactly the same reason.
 */
export const ASSET_ALLOWED_MIME: ReadonlyMap<string, string> = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
]);

async function bucket(): Promise<GridFSBucket> {
  const mongoose = await connectMongo();
  const db = mongoose.connection.db;
  if (!db) throw new Error("Mongo connection has no database handle");
  return new GridFSBucket(db, { bucketName: BUCKET_NAME });
}

export interface StoredAsset {
  /** GridFS file id, as a hex string. */
  id: string;
  /** The path to persist on the owning document and render in an <img>. */
  url: string;
  contentType: string;
  length: number;
}

export interface PutAssetInput {
  buffer: Buffer;
  contentType: string;
  /** Free-form label for operator-facing listings, e.g. the provider key. */
  label?: string;
  /** Recorded for audit: which kind of record owns this. */
  kind: "provider-logo" | "branding-logo";
}

/** The public URL for a stored asset id. One place, so the route and the
 *  persisted value can never drift apart. */
export function assetUrl(id: string): string {
  return `/api/assets/${id}`;
}

/**
 * Store bytes and return the URL to persist. Callers must have already
 * validated size and sniffed the magic bytes — this layer does not re-derive
 * trust from the client-supplied content type.
 */
export async function putAsset(input: PutAssetInput): Promise<StoredAsset> {
  if (!ASSET_ALLOWED_MIME.has(input.contentType)) {
    throw new Error(`Unsupported asset content type: ${input.contentType}`);
  }
  const b = await bucket();
  const id = new ObjectId();

  await new Promise<void>((resolve, reject) => {
    // The content type lives in `metadata`, not as a top-level option: the
    // installed driver dropped GridFS's legacy `contentType` field, so
    // storing it there would compile against older typings and silently
    // read back undefined here.
    const stream = b.openUploadStreamWithId(id, input.label ?? String(id), {
      metadata: {
        kind: input.kind,
        label: input.label ?? null,
        contentType: input.contentType,
      },
    });
    stream.on("error", reject);
    stream.on("finish", () => resolve());
    stream.end(input.buffer);
  });

  return {
    id: id.toHexString(),
    url: assetUrl(id.toHexString()),
    contentType: input.contentType,
    length: input.buffer.byteLength,
  };
}

export interface FetchedAsset {
  buffer: Buffer;
  contentType: string;
}

/** Read an asset back. Returns null for a malformed or unknown id, so the
 *  route can answer 404 without leaking which of the two it was. */
export async function getAsset(id: string): Promise<FetchedAsset | null> {
  if (!ObjectId.isValid(id)) return null;
  const b = await bucket();
  const oid = new ObjectId(id);

  const files = await b.find({ _id: oid }).limit(1).toArray();
  const file = files[0];
  if (!file) return null;

  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const stream = b.openDownloadStream(oid);
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("error", reject);
    stream.on("end", () => resolve());
  });

  const contentType =
    (file.metadata?.contentType as string | undefined) ??
    "application/octet-stream";
  // Re-check on the way OUT as well as in. A type that is not on the
  // allowlist must never be served from our origin, even if something
  // managed to write it — defence in depth against the stored-XSS path.
  if (!ASSET_ALLOWED_MIME.has(contentType)) return null;

  return { buffer: Buffer.concat(chunks), contentType };
}

/** Best-effort delete. Missing ids are not an error — the caller has already
 *  repointed the document, so a failed cleanup must not fail the request. */
export async function deleteAsset(id: string): Promise<void> {
  if (!ObjectId.isValid(id)) return;
  const b = await bucket();
  try {
    await b.delete(new ObjectId(id));
  } catch {
    // Already gone, or never existed.
  }
}

/** True when a stored logo value points at this asset store rather than at
 *  a path baked into the repo's `public/` directory. Lets callers keep
 *  serving the committed seed logos untouched. */
export function isAssetUrl(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith("/api/assets/");
}

/** Extract the id from an asset URL, or null if it is not one. */
export function assetIdFromUrl(value: string | null | undefined): string | null {
  if (!isAssetUrl(value)) return null;
  const id = value!.slice("/api/assets/".length).split(/[?#]/)[0];
  return ObjectId.isValid(id) ? id : null;
}
