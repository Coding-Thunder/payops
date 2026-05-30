import {
  Schema,
  type HydratedDocument,
  type Model,
  type Types,
} from "mongoose";

import { registerModel } from "./register";

/**
 * Pass 6d — saved customer records.
 *
 * Lightweight per-tenant contact book. Auto-populated when an operator
 * creates an order: the customer block (name/email/phone) is upserted
 * here so the next order to the same email pre-fills name + phone.
 *
 * Deliberately *not* the canonical source of truth — every Order still
 * snapshots its own customer fields. This collection exists only to
 * eliminate retyping for repeat customers.
 */
export interface CustomerDoc {
  orgId: Types.ObjectId;
  name: string;
  email: string;
  phone: string;
  ordersCount: number;
  lastOrderAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type CustomerDocument = HydratedDocument<CustomerDoc>;

const customerSchema = new Schema<CustomerDoc>(
  {
    orgId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      maxlength: 254,
    },
    phone: { type: String, required: true, trim: true, maxlength: 32 },
    ordersCount: { type: Number, default: 0, min: 0 },
    lastOrderAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "customers",
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

customerSchema.index(
  { orgId: 1, email: 1 },
  {
    unique: true,
    partialFilterExpression: { orgId: { $type: "objectId" } },
    name: "customers_orgId_email_unique",
  },
);

export const Customer: Model<CustomerDoc> = registerModel<CustomerDoc>(
  "Customer",
  customerSchema,
);
