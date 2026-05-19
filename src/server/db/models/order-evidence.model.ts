import {
  Schema,
  type HydratedDocument,
  type Model,
  type Types,
} from "mongoose";

import {
  ORDER_EVIDENCE_ACTOR_TYPES,
  ORDER_EVIDENCE_EVENT_TYPES,
  OrderEvidenceActorType,
  OrderEvidenceEventType,
  USER_ROLES,
  UserRole,
} from "@/lib/constants/enums";

/**
 * Per-order, append-only evidence chain.
 *
 * One document per dispute-relevant state change on an order. Documents
 * carry a snapshot of the event payload (including full rendered email
 * HTML for the email-sent events), are chained by `previousHash`/`hash`,
 * and are protected against in-place mutation by a pre-save hook. The
 * only writer is `recordEvidence` in the evidence service.
 *
 * Why a sibling collection rather than reusing `audit_logs`:
 *   - audit_logs can be purged by admins (existing `AUDIT_DELETE`
 *     permission); evidence must be permanent for the lifetime of the
 *     order
 *   - payloads embed rendered email HTML (~50–150 KB) — we don't want
 *     to bloat audit queries
 *   - chain integrity is per-order; mixing with the global audit table
 *     would complicate verification and indexing
 *   - separate access control (`EVIDENCE_VIEW` ≠ `AUDIT_VIEW`)
 */

export interface OrderEvidenceRequest {
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  geoCountry?: string | null;
}

export interface OrderEvidenceActor {
  type: OrderEvidenceActorType;
  userId?: Types.ObjectId | null;
  name?: string | null;
  email?: string | null;
  role?: UserRole | null;
}

/** Indexed, sparse top-level fields that power cross-order search.
 *  Anything queryable lives here; nested-payload-only fields are not
 *  indexed (full-text search isn't a goal). */
export interface OrderEvidenceRefs {
  paymentSessionId?: string | null;
  paymentIntentId?: string | null;
  transactionId?: string | null;
  gatewayEventId?: string | null;
  consentId?: string | null;
  consentTokenHash?: string | null;
  customerEmail?: string | null;
  signatureName?: string | null;
  messageId?: string | null;
}

export interface OrderEvidenceDoc {
  orderId: Types.ObjectId;
  orderNumber: string;
  /** 1..N per order. Unique with orderId so concurrent writers can race
   *  safely on the unique index. */
  sequence: number;
  eventType: OrderEvidenceEventType;
  occurredAt: Date;
  actor: OrderEvidenceActor;
  request?: OrderEvidenceRequest | null;
  payload: Record<string, unknown>;
  refs?: OrderEvidenceRefs | null;
  snapshotHash: string;
  previousHash: string | null;
  hash: string;
  createdAt: Date;
  updatedAt: Date;
}

export type OrderEvidenceDocument = HydratedDocument<OrderEvidenceDoc>;

const requestSchema = new Schema(
  {
    ip: { type: String, default: null, maxlength: 64 },
    userAgent: { type: String, default: null, maxlength: 512 },
    requestId: { type: String, default: null, maxlength: 128 },
    geoCountry: { type: String, default: null, maxlength: 8 },
  },
  { _id: false },
);

const actorSchema = new Schema(
  {
    type: {
      type: String,
      enum: ORDER_EVIDENCE_ACTOR_TYPES,
      required: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    name: { type: String, default: null, maxlength: 160 },
    email: { type: String, default: null, lowercase: true, maxlength: 254 },
    role: { type: String, enum: USER_ROLES, default: null },
  },
  { _id: false },
);

const refsSchema = new Schema(
  {
    paymentSessionId: { type: String, default: null, maxlength: 200 },
    paymentIntentId: { type: String, default: null, maxlength: 200 },
    transactionId: { type: String, default: null, maxlength: 200 },
    gatewayEventId: { type: String, default: null, maxlength: 200 },
    consentId: { type: String, default: null, maxlength: 64 },
    consentTokenHash: { type: String, default: null, maxlength: 128 },
    customerEmail: {
      type: String,
      default: null,
      lowercase: true,
      maxlength: 254,
    },
    signatureName: { type: String, default: null, maxlength: 160 },
    messageId: { type: String, default: null, maxlength: 250 },
  },
  { _id: false },
);

const orderEvidenceSchema = new Schema<OrderEvidenceDoc>(
  {
    orderId: {
      type: Schema.Types.ObjectId,
      ref: "Order",
      required: true,
      index: true,
    },
    orderNumber: { type: String, required: true, maxlength: 32, index: true },
    sequence: { type: Number, required: true, min: 1 },
    eventType: {
      type: String,
      enum: ORDER_EVIDENCE_EVENT_TYPES,
      required: true,
      index: true,
    },
    occurredAt: { type: Date, required: true },
    actor: { type: actorSchema, required: true },
    request: { type: requestSchema, default: null },
    payload: { type: Schema.Types.Mixed, required: true },
    refs: { type: refsSchema, default: null },
    snapshotHash: { type: String, required: true, maxlength: 128 },
    previousHash: { type: String, default: null, maxlength: 128 },
    hash: { type: String, required: true, maxlength: 128 },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "order_evidence",
    toJSON: {
      transform(_doc, ret) {
        const r = ret as Record<string, unknown>;
        r.id = String(r._id);
        delete r._id;
        return r;
      },
    },
  },
);

orderEvidenceSchema.index({ orderId: 1, sequence: 1 }, { unique: true });
orderEvidenceSchema.index({ orderId: 1, createdAt: 1 });
orderEvidenceSchema.index({ eventType: 1, createdAt: -1 });
orderEvidenceSchema.index({ "refs.customerEmail": 1 }, { sparse: true });
orderEvidenceSchema.index({ "refs.paymentSessionId": 1 }, { sparse: true });
orderEvidenceSchema.index({ "refs.paymentIntentId": 1 }, { sparse: true });
orderEvidenceSchema.index({ "refs.transactionId": 1 }, { sparse: true });
orderEvidenceSchema.index({ "refs.gatewayEventId": 1 }, { sparse: true });
orderEvidenceSchema.index({ "refs.consentTokenHash": 1 }, { sparse: true });
orderEvidenceSchema.index({ "refs.signatureName": 1 }, { sparse: true });

const APPEND_ONLY_MESSAGE =
  "OrderEvidence is append-only — events cannot be modified";

// Append-only guard: any save() that's not an insert is rejected. The
// only legitimate writer is recordEvidence(), which does fresh creates.
// Catches accidental updates from new code that's added later as well as
// in-memory mutation in unit tests. We use the throw-style hook (matches
// order.model.ts) because Mongoose 9's typings overload `pre()` with a
// SchemaPreOptions form that resolves first when the handler takes a
// `next` callback in TS.
orderEvidenceSchema.pre("save", function () {
  if (!this.isNew) {
    throw new Error(APPEND_ONLY_MESSAGE);
  }
});

orderEvidenceSchema.pre("findOneAndUpdate", function () {
  throw new Error(APPEND_ONLY_MESSAGE);
});

orderEvidenceSchema.pre("updateOne", function () {
  throw new Error(APPEND_ONLY_MESSAGE);
});

orderEvidenceSchema.pre("updateMany", function () {
  throw new Error(APPEND_ONLY_MESSAGE);
});

import { registerModel } from "./register";
export const OrderEvidence: Model<OrderEvidenceDoc> =
  registerModel<OrderEvidenceDoc>("OrderEvidence", orderEvidenceSchema);
