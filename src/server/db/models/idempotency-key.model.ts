import { Schema, type HydratedDocument, type Model } from "mongoose";

import { registerModel } from "./register";

/**
 * One row per client-supplied Idempotency-Key (scoped by route). The unique
 * index turns "insert" into an atomic claim: the first request for a key
 * wins and runs the action; a retry with the same key collides and is served
 * the already-processed result instead of re-running. Rows self-expire.
 */
export interface IdempotencyKeyDoc {
  /** `${route}:${clientKey}` — unique across the collection. */
  key: string;
  createdAt: Date;
  /** TTL anchor — the row is removed this long after creation. */
  expiresAt: Date;
}

export type IdempotencyKeyDocument = HydratedDocument<IdempotencyKeyDoc>;

const idempotencyKeySchema = new Schema<IdempotencyKeyDoc>(
  {
    key: { type: String, required: true, unique: true, maxlength: 200 },
    createdAt: { type: Date, required: true, default: Date.now },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false, collection: "idempotency_keys" },
);

// Mongo auto-removes the row at `expiresAt` (24h window is plenty for a
// user-action retry).
idempotencyKeySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const IdempotencyKey: Model<IdempotencyKeyDoc> =
  registerModel<IdempotencyKeyDoc>("IdempotencyKey", idempotencyKeySchema);
