import {
  Schema,
  type HydratedDocument,
  type Model,
  type Types,
} from "mongoose";

import {
  CONSENT_STATUSES,
  ConsentStatus,
  CURRENCIES,
  Currency,
  DISPUTE_OUTCOMES,
  DISPUTE_STATUSES,
  DisputeOutcome,
  DisputeStatus,
  OrderStatus,
  PAYMENT_GATEWAY_KEYS,
  PaymentGatewayKey,
  RECORD_STATES,
  RecordState,
} from "@/lib/constants/enums";
import {
  ITEM_TYPE_KEY_REGEX,
  SchedulingType,
  SCHEDULING_TYPES,
} from "@/lib/constants/items";

export interface OrderDoc {
  /** Tenant boundary. Nullable during the single-tenant → multi-tenant
   *  migration window so legacy rows can be backfilled without rejecting
   *  reads. Becomes required in a follow-up pass once every row carries
   *  one and every write site has been migrated to `OrgScopedRepo`. */
  orgId?: Types.ObjectId | null;
  orderNumber: string;
  /** Workflow status key. Free string (validated at the workflow
   *  service layer, not the schema), so tenants can define their own
   *  status values. Defaults map 1:1 to the legacy OrderStatus enum. */
  status: string;
  state: RecordState;

  customer: {
    name: string;
    email: string;
    phone: string;
  };
  pricing: {
    /** Stored in MAJOR units (e.g. dollars), 2-decimal precision. */
    amount: number;
    currency: Currency;
  };
  payment: {
    /** Which gateway routes this payment. Null while NOT_INITIATED -
     *  no gateway has been contacted yet. Stamped at LINK_GENERATED
     *  and frozen for the lifetime of the order. */
    gateway?: PaymentGatewayKey | null;
    /** Provider-side session id. Field name predates the multi-gateway
     *  refactor, under non-Stripe gateways this holds whatever the
     *  gateway returns as its session identifier. DTO surfaces it
     *  as the generic `paymentSessionId`. */
    stripeSessionId?: string | null;
    paymentIntentId?: string | null;
    checkoutUrl?: string | null;
    /** Workflow status key. Free string (validated at the workflow
   *  service layer, not the schema), so tenants can define their own
   *  status values. Defaults map 1:1 to the legacy OrderStatus enum. */
  status: string;
    paidAt?: Date | null;
    expiresAt?: Date | null;
    /** When the gateway session was created, order moves NOT_INITIATED
     *  → LINK_GENERATED at this point via the agent's explicit
     *  "Generate Payment Link" action. */
    initiatedAt?: Date | null;
    amountReceived?: number | null;
    receiptUrl?: string | null;
    failureReason?: string | null;
    confirmationEmailSentAt?: Date | null;
    processedWebhookEventIds: string[];
  };
  createdBy: {
    userId: Types.ObjectId;
    name: string;
    email: string;
  };

  /**
   * Phase 5b, universal commerce line items.
   *
   * Optional / nullable during the cutover. Tenant #1's existing
   * Order rows have `lineItems: []` (default). New orders post-Pass
   * 5d will populate this; once Tenant #1 is migrated (Pass 5c) and
   * the deprecated `vehicle/trip/provider` fields are dropped (Pass
   * 5h), this becomes the canonical "what the customer is paying
   * for" structure.
   *
   * Each entry is a SNAPSHOT taken at order-create time, `name`,
   * `unitPrice`, and resolved `attributes` are frozen so a later
   * Catalog edit / archive doesn't rewrite history.
   */
  lineItems?: OrderLineItem[];

  /**
   * Optional time window the order is bound to. Mirrors the legacy
   * `trip` subdoc for rental orders but is generic: appointment
   * slots, subscription cycles, consulting engagements all use the
   * same shape. Null for retail / one-shot service orders.
   *
   * Pass 5c migration copies Tenant #1's existing `trip` →
   * `scheduling` with `type: FIXED_WINDOW`. New orders set this
   * directly from the form when at least one line's ItemType has
   * `requiresScheduling`.
   */
  scheduling?: OrderScheduling | null;

  /** Snapshot of the cancellation policy at the moment this order was
   *  created. Frozen for the lifetime of the order so disputes can show
   *  the exact terms the customer was charged under. */
  policy: {
    acceptedAt: Date;
    version: string;
    text: string;
  };
  /** Operator-facing risk flag. Lets admins mark an order as "watch this"
   *  (customer complaint, chargeback warning, contested charge, etc.).
   *  Surfaces on the /admin/disputes page. */
  risk: {
    flagged: boolean;
    flaggedNote?: string | null;
    flaggedAt?: Date | null;
    flaggedBy?: {
      userId?: Types.ObjectId | null;
      name?: string | null;
    } | null;
  };
  /** Denormalised pointer to the latest PaymentConsent. Keeps the order
   *  list query single-collection, the full audit trail lives in the
   *  payment_consents collection (multiple docs per order allowed). */
  consent: {
    status: ConsentStatus;
    currentConsentId?: Types.ObjectId | null;
    requestedAt?: Date | null;
    receivedAt?: Date | null;
    verifiedAt?: Date | null;
    method?: string | null;
  };
  /** Denormalised pointer to the latest Dispute. Null until the first
   *  chargeback lands. The full dispute history lives in the `disputes`
   *  collection, this pointer keeps order list views single-collection
   *  for the at-risk dashboard. */
  dispute?: {
    status: DisputeStatus | null;
    currentDisputeId?: Types.ObjectId | null;
    openedAt?: Date | null;
    closedAt?: Date | null;
    outcome?: DisputeOutcome | null;
    reason?: string | null;
    amount?: number | null;
    currency?: Currency | null;
  } | null;
  /** Cumulative refunded amount across all `refund.created` events the
   *  gateway delivered. Major units. Stays at 0 until the first refund. */
  refundedAmount?: number;
  notes?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Universal commerce line item. Snapshot embedded on the Order at
 * create-time so the order's "what was bought" stays consistent even
 * when the catalog row is later edited / archived.
 *
 * `attributes` shape is per-tenant per-vertical, validated at the
 * service layer against the referenced `ItemType.attributeSchema`.
 * Persisted as `Mixed` because the SCHEMA is per-org, we deliberately
 * don't push that knowledge into the persistence layer.
 */
export interface OrderLineItem {
  /** Catalog reference. Null for ad-hoc lines (e.g. one-off charges,
   *  custom service items that aren't worth a catalog row). */
  itemId?: Types.ObjectId | null;
  /** Stable identifier matching `ItemType.key`. Persisted so the
   *  email renderer can pick the right blocks without joining
   *  back to the live ItemType (which might have been edited). */
  itemTypeKey: string;
  /** Snapshot from the Item.name at creation time. */
  name: string;
  description?: string | null;
  quantity: number;
  /** Major units. Mirrors Order.pricing convention. */
  unitPrice: number;
  /** Computed = `quantity * unitPrice`. Snapshotted so a later
   *  pricingModel change can't retroactively edit historical totals. */
  total: number;
  /** Per-vertical payload. Validated against ItemType at service-layer. */
  attributes: Record<string, unknown>;
  /** Optional line-level scheduling (e.g. one of two cars rented for
   *  different windows). Falls back to the order-level scheduling
   *  when null. */
  scheduling?: OrderScheduling | null;
}

/**
 * Order-level (or line-level) time window. Universal across rental
 * bookings, appointment slots, subscription cycles, consulting
 * engagements. Null on retail / one-shot orders.
 */
export interface OrderScheduling {
  type: SchedulingType;
  startsAt: Date;
  /** Required for FIXED_WINDOW + RECURRING_INTERVAL; nullable for
   *  OPEN_ENDED (consulting engagement, open-tab service). */
  endsAt?: Date | null;
}

export type OrderDocument = HydratedDocument<OrderDoc>;

const customerSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      maxlength: 254,
    },
    phone: { type: String, required: true, trim: true, maxlength: 32 },
  },
  { _id: false },
);

const pricingSchema = new Schema(
  {
    amount: {
      type: Number,
      required: true,
      min: 0.5,
      validate: {
        validator: (v: number) => Number.isFinite(v) && v > 0,
        message: "Amount must be a positive number",
      },
    },
    currency: { type: String, enum: CURRENCIES, required: true },
  },
  { _id: false },
);

const paymentSchema = new Schema(
  {
    gateway: {
      type: String,
      enum: PAYMENT_GATEWAY_KEYS,
      default: null,
    },
    stripeSessionId: { type: String, default: null, index: true, sparse: true },
    paymentIntentId: { type: String, default: null, index: true, sparse: true },
    checkoutUrl: { type: String, default: null },
    // Status validation moved from the schema enum to the workflow
    // service: tenants pick their own status keys, so the constraint
    // lives at the per-tenant config layer (workflow.service.resolveTransition)
    // not on the platform-wide model. Keep maxlength as a defensive
    // cap so a corrupt write can't blow out the index.
    status: { type: String, required: true, maxlength: 48 },
    paidAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    initiatedAt: { type: Date, default: null },
    amountReceived: { type: Number, default: null },
    receiptUrl: { type: String, default: null },
    failureReason: { type: String, default: null },
    confirmationEmailSentAt: { type: Date, default: null },
    processedWebhookEventIds: { type: [String], default: [] },
  },
  { _id: false },
);

const creatorSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    name: { type: String, required: true },
    email: { type: String, required: true, lowercase: true },
  },
  { _id: false },
);

const policySchema = new Schema(
  {
    acceptedAt: { type: Date, required: true, default: Date.now },
    version: { type: String, required: true, maxlength: 16, default: "v1" },
    // Empty allowed: tenant may not have set a cancellation policy
    // during onboarding. Email's policy block early-returns on empty
    // so the receipt simply omits the section.
    text: { type: String, default: "", maxlength: 4000 },
  },
  { _id: false },
);

/* ────────── Pass 5b, universal commerce subdocs (additive) ──────────── */

/**
 * Order.scheduling, optional time window. Same shape used at the
 * line-item level when individual lines diverge from the order-level
 * window.
 */
const orderSchedulingSchema = new Schema<OrderScheduling>(
  {
    type: { type: String, enum: SCHEDULING_TYPES, required: true },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, default: null },
  },
  { _id: false },
);

/**
 * Order.lineItems[], universal commerce line item. Replaces the
 * rental-shaped `vehicle/trip/provider` triple over Pass 5c–5h.
 *
 * `attributes` is `Schema.Types.Mixed` deliberately: the per-tenant
 * ItemType.attributeSchema defines what's allowed, and service-layer
 * validation in Pass 5d will refuse unknown keys + enforce types.
 * Keeping the persistence layer schema-shape-free means new
 * verticals don't require a Mongoose model change.
 */
const orderLineItemSchema = new Schema<OrderLineItem>(
  {
    itemId: {
      type: Schema.Types.ObjectId,
      ref: "Item",
      default: null,
    },
    itemTypeKey: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 32,
      match: ITEM_TYPE_KEY_REGEX,
    },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, default: null, maxlength: 2000 },
    quantity: { type: Number, required: true, min: 1, default: 1 },
    // Major units. Same convention as `pricing.amount`. Allow 0 for
    // promo lines / waived charges; total stays a function of qty
    // × unitPrice computed at the service layer.
    unitPrice: { type: Number, required: true, min: 0 },
    total: { type: Number, required: true, min: 0 },
    attributes: { type: Schema.Types.Mixed, default: () => ({}) },
    scheduling: { type: orderSchedulingSchema, default: null },
  },
  { _id: false },
);

const riskFlaggedBySchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    name: { type: String, default: null },
  },
  { _id: false },
);

const riskSchema = new Schema(
  {
    flagged: { type: Boolean, default: false, index: true },
    flaggedNote: { type: String, default: null, maxlength: 2000 },
    flaggedAt: { type: Date, default: null },
    flaggedBy: { type: riskFlaggedBySchema, default: null },
  },
  { _id: false },
);

const consentPointerSchema = new Schema(
  {
    status: {
      type: String,
      enum: CONSENT_STATUSES,
      required: true,
      default: "NOT_REQUESTED",
      index: true,
    },
    currentConsentId: {
      type: Schema.Types.ObjectId,
      ref: "PaymentConsent",
      default: null,
    },
    requestedAt: { type: Date, default: null },
    receivedAt: { type: Date, default: null },
    verifiedAt: { type: Date, default: null },
    method: { type: String, default: null, maxlength: 24 },
  },
  { _id: false },
);

const disputePointerSchema = new Schema(
  {
    status: {
      type: String,
      enum: DISPUTE_STATUSES,
      default: null,
      index: true,
    },
    currentDisputeId: {
      type: Schema.Types.ObjectId,
      ref: "Dispute",
      default: null,
    },
    openedAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },
    outcome: { type: String, enum: DISPUTE_OUTCOMES, default: null },
    reason: { type: String, default: null, maxlength: 80 },
    amount: { type: Number, default: null },
    currency: { type: String, enum: CURRENCIES, default: null },
  },
  { _id: false },
);

const orderSchema = new Schema<OrderDoc>(
  {
    orgId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      default: null,
      index: true,
    },
    orderNumber: {
      type: String,
      required: true,
      unique: true,
      index: true,
      maxlength: 32,
    },
    // Same as payment.status above: validation lives on the workflow
    // service, not the schema. The default "PAYMENT_PENDING" stays
    // here because this is a fallback for the legacy single-tenant
    // path; new orders are created with workflow.initialStatusKey.
    status: {
      type: String,
      required: true,
      default: "PAYMENT_PENDING",
      index: true,
      maxlength: 48,
    },
    state: {
      type: String,
      enum: RECORD_STATES,
      required: true,
      default: "ACTIVE",
      index: true,
    },
    customer: { type: customerSchema, required: true },
    pricing: { type: pricingSchema, required: true },
    payment: { type: paymentSchema, required: true },
    createdBy: { type: creatorSchema, required: true },
    // Pass 5b, universal commerce additions (optional, default
    // empty/null). Existing rental orders are unaffected; new code
    // paths (Pass 5d+) will populate these on every order.
    lineItems: { type: [orderLineItemSchema], default: () => [] },
    scheduling: { type: orderSchedulingSchema, default: null },
    policy: {
      type: policySchema,
      required: true,
      default: () => ({ acceptedAt: new Date(), version: "v1", text: "" }),
    },
    risk: {
      type: riskSchema,
      required: true,
      default: () => ({ flagged: false }),
    },
    consent: {
      type: consentPointerSchema,
      required: true,
      default: () => ({ status: "NOT_REQUESTED" }),
    },
    dispute: {
      type: disputePointerSchema,
      default: null,
    },
    refundedAmount: { type: Number, default: 0, min: 0 },
    notes: { type: String, default: null, maxlength: 2000 },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "orders",
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

orderSchema.index({ status: 1, createdAt: -1 });
orderSchema.index({ "createdBy.userId": 1, createdAt: -1 });
orderSchema.index({ "customer.email": 1, createdAt: -1 });
orderSchema.index({ state: 1, createdAt: -1 });
orderSchema.index({ "provider.id": 1, createdAt: -1 });
orderSchema.index({ "consent.status": 1, createdAt: -1 });
orderSchema.index({ "dispute.status": 1, "dispute.openedAt": -1 });
// Org-scoped list queries, every multi-tenant read filters on orgId.
// Partial index ignores legacy null-orgId rows so the index stays small
// during the migration window.
orderSchema.index(
  { orgId: 1, createdAt: -1 },
  { partialFilterExpression: { orgId: { $exists: true, $ne: null } } },
);
orderSchema.index(
  { orgId: 1, status: 1, createdAt: -1 },
  { partialFilterExpression: { orgId: { $exists: true, $ne: null } } },
);
// Compound uniqueness for `orderNumber` per-tenant. The legacy global
// unique index on `orderNumber` (above) stays in place during migration
// so dual-write paths can't collide. Drop the global unique in a later
// pass once every order carries an orgId.
orderSchema.index(
  { orgId: 1, orderNumber: 1 },
  {
    unique: true,
    partialFilterExpression: { orgId: { $type: "objectId" } },
    name: "orders_orgId_orderNumber_unique",
  },
);
// `payment.stripeSessionId` already has `index: true, sparse: true` on the
// field definition, declaring it again here triggers a duplicate-index
// warning at startup. Keep it on the field, drop the schema-level call.

orderSchema.pre("validate", function () {
  if (this.scheduling?.startsAt && this.scheduling?.endsAt) {
    if (this.scheduling.startsAt >= this.scheduling.endsAt) {
      throw new Error("Scheduling end must be after start");
    }
  }
});

import { registerModel } from "./register";
export const Order: Model<OrderDoc> = registerModel<OrderDoc>(
  "Order",
  orderSchema,
);
