import {
  Schema,
  type HydratedDocument,
  type Model,
  type Types,
} from "mongoose";

import {
  CURRENCIES,
  Currency,
  DISPUTE_OUTCOMES,
  DISPUTE_STATUSES,
  DisputeOutcome,
  DisputeStatus,
  PAYMENT_GATEWAY_KEYS,
  PaymentGatewayKey,
} from "@/lib/constants/enums";

/**
 * One Dispute doc per chargeback raised against an order's payment.
 *
 * Mirrors the PaymentConsent model: a sibling collection rather than a
 * field on Order so we can hold multiple disputes per order over time
 * (re-presentment, separate chargebacks against multi-charge intents)
 * without rewriting the order schema. Order keeps a denormalised
 * `dispute: { status, currentDisputeId, openedAt, closedAt, outcome }`
 * pointer for list-view rendering, see [order.model.ts](order.model.ts).
 *
 * Lifecycle is driven entirely by Stripe webhooks: created → updated*
 * → closed. The handler is idempotent via `processedWebhookEventIds`
 * (per-dispute, not per-order, the same Stripe event id can be
 * delivered to multiple disputes on the same order in rare cases).
 */
export interface DisputeDoc {
  orderId: Types.ObjectId;
  /** Tenant boundary, denormalised from the parent Order at create
   *  time so dispute queries can scope by orgId without a JOIN, and
   *  cross-tenant id-guesses fail at the find filter rather than
   *  relying on the parent Order's orgId pin alone. Nullable during
   *  the multi-tenant migration window; required for new rows. */
  orgId?: Types.ObjectId | null;
  /** Denormalised lookup so admin views can render order context
   *  without a JOIN. Frozen at creation. */
  orderNumber: string;

  gateway: PaymentGatewayKey;
  /** Gateway-side dispute id. Unique across all gateways. */
  gatewayDisputeId: string;
  /** Charge id the dispute targets on the gateway side. */
  chargeId: string | null;
  /** Payment-intent id, used as the order-lookup key when the dispute
   *  webhook arrives. Indexed for fast `findOneAndUpdate`. */
  paymentIntentId: string | null;

  status: DisputeStatus;
  reason: string | null;
  /** Set when the dispute closes; null while still open. */
  outcome: DisputeOutcome | null;

  /** Stored in MAJOR units (e.g. dollars), 2-decimal precision. */
  amount: number;
  /** Stripe's raw minor-unit value, kept so reconciliation is exact
   *  even for zero-decimal currencies the major-unit conversion lossy. */
  amountMinor: number;
  currency: Currency;

  /** When the cardholder has to submit evidence. Stripe's deadline. */
  evidenceDueAt: Date | null;

  openedAt: Date;
  closedAt: Date | null;

  /** Idempotency list, the gateway event id is appended on each
   *  applied transition. Same id replayed is a no-op. */
  processedWebhookEventIds: string[];

  createdAt: Date;
  updatedAt: Date;
}

export type DisputeDocument = HydratedDocument<DisputeDoc>;

const disputeSchema = new Schema<DisputeDoc>(
  {
    orderId: {
      type: Schema.Types.ObjectId,
      ref: "Order",
      required: true,
      index: true,
    },
    orgId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      default: null,
      index: true,
    },
    orderNumber: { type: String, required: true, maxlength: 32 },
    gateway: {
      type: String,
      enum: PAYMENT_GATEWAY_KEYS,
      required: true,
    },
    gatewayDisputeId: {
      type: String,
      required: true,
      unique: true,
      maxlength: 128,
    },
    chargeId: { type: String, default: null, maxlength: 128, index: true },
    paymentIntentId: {
      type: String,
      default: null,
      maxlength: 128,
      index: true,
    },
    status: {
      type: String,
      enum: DISPUTE_STATUSES,
      required: true,
      index: true,
    },
    reason: { type: String, default: null, maxlength: 80 },
    outcome: {
      type: String,
      enum: DISPUTE_OUTCOMES,
      default: null,
    },
    amount: { type: Number, required: true, min: 0 },
    amountMinor: { type: Number, required: true, min: 0 },
    currency: { type: String, enum: CURRENCIES, required: true },
    evidenceDueAt: { type: Date, default: null },
    openedAt: { type: Date, required: true, default: Date.now },
    closedAt: { type: Date, default: null },
    processedWebhookEventIds: { type: [String], default: [] },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "disputes",
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

disputeSchema.index({ orderId: 1, openedAt: -1 });
// Tenant-scoped admin queries (dispute list per workspace).
disputeSchema.index({ orgId: 1, openedAt: -1 });
disputeSchema.index({ status: 1, openedAt: -1 });

import { registerModel } from "./register";
export const Dispute: Model<DisputeDoc> = registerModel<DisputeDoc>(
  "Dispute",
  disputeSchema,
);
