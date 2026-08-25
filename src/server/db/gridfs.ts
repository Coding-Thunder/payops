import "server-only";

import mongoose, { Types } from "mongoose";

import { connectMongo } from "@/server/db/mongoose";

/**
 * GridFS access for uploaded file bytes.
 *
 * Why GridFS and not a Buffer field (which is what the branding logo
 * uses): a logo is capped at 512 KB, but a client file may be 25 MB —
 * well past Mongo's 16 MB per-document ceiling. GridFS chunks it. And
 * why Mongo at all rather than disk: the platform filesystem is
 * ephemeral, so anything written to `public/` disappears on the next
 * deploy and is invisible to a second instance.
 *
 * Object storage (S3/Spaces) is the eventual home; this module is the
 * seam where that swap happens — nothing above it knows where bytes live,
 * only that a `storageId` addresses them.
 */
export async function getBucket(
  bucketName: string,
): Promise<mongoose.mongo.GridFSBucket> {
  const conn = await connectMongo();
  const db = conn.connection.db;
  if (!db) {
    throw new Error("Mongo connection has no database handle");
  }
  return new mongoose.mongo.GridFSBucket(db, { bucketName });
}

/** Store a buffer, returning its GridFS id. */
export async function putBytes(
  bucketName: string,
  fileName: string,
  buffer: Buffer,
  metadata?: Record<string, unknown>,
): Promise<Types.ObjectId> {
  const bucket = await getBucket(bucketName);
  return new Promise((resolve, reject) => {
    const stream = bucket.openUploadStream(fileName, { metadata });
    stream.on("error", reject);
    stream.on("finish", () => resolve(stream.id as Types.ObjectId));
    stream.end(buffer);
  });
}

/** Read every chunk back into one buffer. Only ever called for a single
 *  file at a time (download, or one email attachment), so the 25 MB cap
 *  bounds the memory this can hold. */
export async function readBytes(
  bucketName: string,
  storageId: Types.ObjectId,
): Promise<Buffer> {
  const bucket = await getBucket(bucketName);
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    bucket
      .openDownloadStream(storageId)
      .on("data", (chunk: Buffer) => chunks.push(chunk))
      .on("error", reject)
      .on("end", () => resolve(Buffer.concat(chunks)));
  });
}

/** Best-effort byte removal. A missing GridFS entry is not an error —
 *  the metadata row is the record, and a delete that already happened
 *  must not block the one the operator just asked for. */
export async function deleteBytes(
  bucketName: string,
  storageId: Types.ObjectId,
): Promise<void> {
  const bucket = await getBucket(bucketName);
  try {
    await bucket.delete(storageId);
  } catch {
    // Already gone (or never written) — nothing to reclaim.
  }
}
