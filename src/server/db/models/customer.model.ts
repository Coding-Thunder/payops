import {
  Schema,
  type HydratedDocument,
  type Model,
  type Types,
} from "mongoose";

import { registerModel } from "./register";

/**
 * Client Profile — the permanent per-tenant System of Record for a
 * customer.
 *
 * Originally (Pass 6d) a lightweight prefill cache. Promoted in the
 * Client Profile pass to the canonical customer spine: every Order now
 * carries a stable `customerId` FK back to one of these rows (resolved
 * email → phone → create at order time; see `resolveOrCreateCustomer`).
 *
 * The Order still snapshots its own customer block — that snapshot is
 * frozen point-in-time evidence and must never be rewritten. This row
 * is the *live* identity + the anchor every downstream aggregation
 * (lifetime revenue, timeline, refunds) hangs off. Financial totals are
 * computed on read from the linked orders (never denormalised here, so
 * they can't drift when a webhook posts a payment or refund); the
 * counters below are cheap list-view caches, not sources of truth.
 */
export interface CustomerDoc {
  orgId: Types.ObjectId;
  name: string;
  email: string;
  /** May be empty: a client can be identified by email alone. Kept as a
   *  secondary linking key (email → phone → create). */
  phone: string;
  /** Optional CRM-lite identity fields. Editable from the profile page. */
  company: string | null;
  notes: string | null;
  /** Free-form labels. Architecture-ready for saved segments / filters. */
  tags: string[];
  /** Cheap list-view caches, maintained best-effort on order create and
   *  rebuilt authoritatively by the backfill migration. Never trusted
   *  for financials — the profile recomputes those from orders. */
  ordersCount: number;
  firstOrderAt: Date | null;
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
    // Not required: a client may be keyed by email alone. Existing rows
    // all carry a phone already, so relaxing this is backward-safe.
    phone: { type: String, default: "", trim: true, maxlength: 32 },
    company: { type: String, default: null, trim: true, maxlength: 160 },
    notes: { type: String, default: null, maxlength: 4000 },
    tags: {
      type: [String],
      default: () => [],
      validate: {
        validator: (v: string[]) => v.length <= 50,
        message: "A client can carry at most 50 tags",
      },
    },
    ordersCount: { type: Number, default: 0, min: 0 },
    firstOrderAt: { type: Date, default: null },
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

// Secondary linking key: resolve a client by phone when the email is
// new but the phone matches an existing profile. Partial so the huge
// tail of empty-phone rows never enters the index.
customerSchema.index(
  { orgId: 1, phone: 1 },
  {
    partialFilterExpression: { phone: { $gt: "" } },
    name: "customers_orgId_phone",
  },
);

// Clients list default sort: most-recently-active first, tenant-scoped.
customerSchema.index({ orgId: 1, lastOrderAt: -1 });

export const Customer: Model<CustomerDoc> = registerModel<CustomerDoc>(
  "Customer",
  customerSchema,
);
