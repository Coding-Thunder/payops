import {
  Schema,
  type HydratedDocument,
  type Model,
  type Types,
} from "mongoose";

import {
  FILE_VISIBILITIES,
  FileVisibility,
  RESOURCE_SOURCES,
  ResourceActorType,
  ResourceSource,
} from "@/lib/constants/client-resources";

import { registerModel } from "./register";

/**
 * A file attached to a client relationship.
 *
 * ONE row per file, always. The brief is explicit: "Do not duplicate the
 * file. Use relationships so the same file can appear in multiple
 * contextual views." So a file carries a mandatory `customerId` and an
 * OPTIONAL `orderId`:
 *
 *   Client Files → every row for the client.
 *   Order Files  → the subset whose `orderId` matches.
 *
 * Attaching a file to an order therefore doesn't copy anything; it sets
 * one field, and the row appears in both views at once.
 *
 * Bytes live in GridFS (bucket `client_files`), not on this document:
 * the 25 MB upload cap is above Mongo's 16 MB per-document ceiling, and
 * the platform filesystem is ephemeral so `public/` is not an option
 * (same reasoning as the branding logo, which stores bytes in Mongo).
 * `storageId` is the GridFS file id.
 *
 * Deletes are soft (`deletedAt`). A file may already have gone out as an
 * email attachment, and the Timeline is a historical record — removing
 * the row outright would rewrite history.
 */
export interface ClientFileDoc {
  orgId: Types.ObjectId;
  /** The client this file belongs to. Never null: a file with no client
   *  has no context, and context is the entire product premise. */
  customerId: Types.ObjectId;
  /** Optional order relationship. Null = client-level only. */
  orderId?: Types.ObjectId | null;
  /** Denormalised so Order Files can render "Order ORD-…" without a
   *  join, and so the label survives even if the order is archived. */
  orderNumber?: string | null;

  /** Original name as uploaded, sanitised. Shown everywhere. */
  fileName: string;
  /** Lower-case, no dot. Mirrors SUPPORTED_FILE_FORMATS.extension. */
  extension: string;
  /** Canonical Content-Type; what the download route serves. */
  mimeType: string;
  sizeBytes: number;
  /** GridFS file id in the `client_files` bucket. */
  storageId: Types.ObjectId;
  /** SHA-256 of the bytes. Integrity + future dedupe. */
  checksum: string;

  description?: string | null;
  visibility: FileVisibility;
  source: ResourceSource;

  addedBy: {
    /** Null for client-provided files (no TraceTxn account). */
    userId?: Types.ObjectId | null;
    name: string;
    actorType: ResourceActorType;
  };

  /** Set the first time the file is marked shared with the client;
   *  drives the "shared X with the client" timeline event. */
  sharedWithClientAt?: Date | null;
  /** Email provenance — powers the "Sent via email" filter and the
   *  "sent via email" timeline event. */
  emailSendCount: number;
  lastEmailedAt?: Date | null;

  deletedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ClientFileDocument = HydratedDocument<ClientFileDoc>;

const addedBySchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    name: { type: String, required: true, maxlength: 200 },
    actorType: {
      type: String,
      enum: ["BUSINESS", "CLIENT"] satisfies ResourceActorType[],
      required: true,
      default: "BUSINESS",
    },
  },
  { _id: false },
);

const clientFileSchema = new Schema<ClientFileDoc>(
  {
    orgId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    customerId: {
      type: Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
      index: true,
    },
    orderId: {
      type: Schema.Types.ObjectId,
      ref: "Order",
      default: null,
    },
    orderNumber: { type: String, default: null, maxlength: 64 },

    fileName: { type: String, required: true, trim: true, maxlength: 255 },
    extension: { type: String, required: true, lowercase: true, maxlength: 16 },
    mimeType: { type: String, required: true, maxlength: 160 },
    sizeBytes: { type: Number, required: true, min: 0 },
    storageId: { type: Schema.Types.ObjectId, required: true },
    checksum: { type: String, required: true, maxlength: 64 },

    description: { type: String, default: null, maxlength: 1000, trim: true },
    visibility: {
      type: String,
      enum: FILE_VISIBILITIES,
      required: true,
      default: FileVisibility.INTERNAL,
    },
    source: {
      type: String,
      enum: RESOURCE_SOURCES,
      required: true,
      default: ResourceSource.DIRECT_UPLOAD,
    },

    addedBy: { type: addedBySchema, required: true },

    sharedWithClientAt: { type: Date, default: null },
    emailSendCount: { type: Number, required: true, default: 0, min: 0 },
    lastEmailedAt: { type: Date, default: null },

    deletedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "client_files",
  },
);

// Client Files tab: newest-first for one client.
clientFileSchema.index({ orgId: 1, customerId: 1, deletedAt: 1, createdAt: -1 });
// Order Files card: newest-first for one order. Partial so the (many)
// client-level rows with a null orderId stay out of the index.
clientFileSchema.index(
  { orgId: 1, orderId: 1, createdAt: -1 },
  { partialFilterExpression: { orderId: { $type: "objectId" } } },
);
// Name search (`q=`) is a prefix/substring regex over a per-client
// slice, so the compound above already narrows it; no text index — the
// brief explicitly rules out enterprise document search.

export const ClientFile: Model<ClientFileDoc> = registerModel<ClientFileDoc>(
  "ClientFile",
  clientFileSchema,
);

/** GridFS bucket that holds the actual bytes. */
export const CLIENT_FILE_BUCKET = "client_files";
