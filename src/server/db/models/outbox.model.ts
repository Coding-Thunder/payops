import {
  Schema,
  type HydratedDocument,
  type Model,
  type Types,
} from "mongoose";

import { EmailKind } from "@/lib/constants/enums";

import { registerModel } from "./register";

/* ─────────────────────────── ProcessedWebhookEvent ──────────────────────── */

/**
 * Durable gateway-event dedupe key store, separate from the Order's
 * `payment.processedWebhookEventIds` array (which is kept as bounded
 * defense-in-depth, capped via $slice in the webhook handler).
 *
 * Concurrent webhook + reconcile deliveries race on `findOneAndUpdate`
 * upserts against the unique `gatewayEventId` index; the loser
 * short-circuits as duplicate. TTL on `processedAt` is set to 90 days
 * — well past Stripe's 3-day retry window but stops the collection
 * growing forever.
 */
export interface ProcessedWebhookEventDoc {
  gatewayEventId: string;
  gateway: string;
  orderId?: Types.ObjectId | null;
  processedAt: Date;
}

export type ProcessedWebhookEventDocument =
  HydratedDocument<ProcessedWebhookEventDoc>;

const processedWebhookEventSchema = new Schema<ProcessedWebhookEventDoc>(
  {
    gatewayEventId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      maxlength: 200,
    },
    gateway: { type: String, required: true, maxlength: 32 },
    orderId: { type: Schema.Types.ObjectId, ref: "Order", default: null },
    processedAt: { type: Date, required: true, default: () => new Date() },
  },
  {
    versionKey: false,
    collection: "processed_webhook_events",
  },
);

processedWebhookEventSchema.index(
  { processedAt: 1 },
  { expireAfterSeconds: 60 * 60 * 24 * 90 },
);

export const ProcessedWebhookEvent: Model<ProcessedWebhookEventDoc> =
  registerModel<ProcessedWebhookEventDoc>(
    "ProcessedWebhookEvent",
    processedWebhookEventSchema,
  );

/* ─────────────────────────────── PendingEmail ───────────────────────────── */

/**
 * DB-backed email outbox. The webhook (or any service that needs to
 * send mail) writes a row inside its transaction; a near-real-time
 * post-commit `setImmediate` drain attempts delivery, and a 60s
 * in-process timer drains any rows still PENDING (durable retry).
 *
 * Status lifecycle:
 *   PENDING ─→ PROCESSING ─→ SENT
 *                         ─→ PENDING (retry with exp backoff)
 *                         ─→ FAILED  (after MAX_ATTEMPTS)
 *
 * Single drainer per row — the conditional findOneAndUpdate
 * (status PENDING → PROCESSING) is the lock so two drainers can never
 * grab the same row. No external infra required.
 */
export const PendingEmailStatus = {
  PENDING: "PENDING",
  PROCESSING: "PROCESSING",
  SENT: "SENT",
  FAILED: "FAILED",
} as const;
export type PendingEmailStatus =
  (typeof PendingEmailStatus)[keyof typeof PendingEmailStatus];

const PENDING_EMAIL_STATUSES = Object.values(PendingEmailStatus);

export interface PendingEmailDoc {
  orderId: Types.ObjectId;
  kind: EmailKind;
  /** Captured for visibility on the admin jobs view. Actual send
   *  re-resolves the recipient from the order at drain time. */
  recipient: string;
  status: PendingEmailStatus;
  attempts: number;
  /** Lower bound on the next drain attempt. Bumped on retry with
   *  exponential backoff + jitter. */
  nextAttemptAt: Date;
  lastError?: string | null;
  /** Set on the SENT transition. Used by TTL cleanup. */
  sentAt?: Date | null;
  /** Free-form payload passed to the email service at drain time —
   *  e.g. copy overrides for payment-request emails. */
  metadata?: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export type PendingEmailDocument = HydratedDocument<PendingEmailDoc>;

const pendingEmailSchema = new Schema<PendingEmailDoc>(
  {
    orderId: {
      type: Schema.Types.ObjectId,
      ref: "Order",
      required: true,
      index: true,
    },
    kind: { type: String, required: true, maxlength: 64 },
    recipient: {
      type: String,
      required: true,
      lowercase: true,
      maxlength: 254,
    },
    status: {
      type: String,
      enum: PENDING_EMAIL_STATUSES,
      required: true,
      default: PendingEmailStatus.PENDING,
      index: true,
    },
    attempts: { type: Number, required: true, default: 0, min: 0 },
    nextAttemptAt: {
      type: Date,
      required: true,
      default: () => new Date(),
      index: true,
    },
    lastError: { type: String, default: null, maxlength: 2000 },
    sentAt: { type: Date, default: null },
    metadata: { type: Schema.Types.Mixed, default: null },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "pending_emails",
  },
);

pendingEmailSchema.index({ status: 1, nextAttemptAt: 1 });

// TTL on SENT rows — keep 7 days for audit visibility, then drop. FAILED
// rows are NOT auto-deleted; ops should review them.
pendingEmailSchema.index(
  { sentAt: 1 },
  {
    expireAfterSeconds: 60 * 60 * 24 * 7,
    partialFilterExpression: { status: PendingEmailStatus.SENT },
  },
);

export const PendingEmail: Model<PendingEmailDoc> =
  registerModel<PendingEmailDoc>("PendingEmail", pendingEmailSchema);
