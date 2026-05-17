import {
  Schema,
  type HydratedDocument,
  type Model,
  type Types,
} from "mongoose";

import { registerModel } from "./register";

/**
 * Server-backed autosave for partially-completed create-order workflows.
 *
 * Drafts are intentionally schemaless inside `data` — the create-order form
 * shape evolves, and validation happens at submit time. The DB only enforces
 * ownership, size, and a TTL so abandoned drafts don't accumulate.
 */
export interface OrderDraftDoc {
  ownerId: Types.ObjectId;
  /**
   * Raw form snapshot — exactly what react-hook-form has at the moment of
   * autosave. Shape mirrors `CreateOrderInput` but with all fields optional.
   */
  data: Record<string, unknown>;
  /** Lightweight pre-computed summary used for tab labels and the drafts
   *  picker. Updated alongside `data` on every save. */
  summary: {
    customerName?: string | null;
    orderAmount?: number | null;
    currency?: string | null;
  };
  /** Bumped on every save — clients use it to resolve write conflicts. */
  revision: number;
  /** When the user last touched this draft. Drives TTL. */
  lastEditedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type OrderDraftDocument = HydratedDocument<OrderDraftDoc>;

const orderDraftSchema = new Schema<OrderDraftDoc>(
  {
    ownerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    data: {
      type: Schema.Types.Mixed,
      required: true,
      default: () => ({}),
    },
    summary: {
      customerName: { type: String, default: null, maxlength: 120 },
      orderAmount: { type: Number, default: null },
      currency: { type: String, default: null, maxlength: 8 },
    },
    revision: { type: Number, required: true, default: 0 },
    lastEditedAt: { type: Date, required: true, default: Date.now },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "order_drafts",
    minimize: false,
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

// Drafts auto-expire 30 days after last edit. Long enough to survive a
// weekend off, short enough to keep the collection bounded.
orderDraftSchema.index(
  { lastEditedAt: 1 },
  { expireAfterSeconds: 60 * 60 * 24 * 30 },
);
orderDraftSchema.index({ ownerId: 1, lastEditedAt: -1 });

export const OrderDraft: Model<OrderDraftDoc> = registerModel<OrderDraftDoc>(
  "OrderDraft",
  orderDraftSchema,
);
