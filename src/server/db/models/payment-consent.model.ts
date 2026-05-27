import {
  Schema,
  type HydratedDocument,
  type Model,
  type Types,
} from "mongoose";

import {
  CONSENT_METHODS,
  CONSENT_STATUSES,
  ConsentMethod,
  ConsentStatus,
  CURRENCIES,
  Currency,
} from "@/lib/constants/enums";

/**
 * One PaymentConsent doc per acknowledgement attempt against an order.
 *
 * Why a sibling collection rather than burying everything on Order:
 *   - records survive even if the order is later archived / merged
 *   - we can hold multiple consent attempts per order (re-sends, declines)
 *     without rewriting the order schema
 *   - public hosted page reads only this collection, keeping the order doc
 *     and its provider/pricing snapshots untouched
 *
 * The Order doc keeps a lightweight `consent: { status, currentId, ... }`
 * pointer (see order.model.ts) so list views and the admin dashboard
 * don't need to JOIN to render status.
 */

export interface PaymentConsentDoc {
  orderId: Types.ObjectId;
  /** Denormalised lookup field — matches Order.orderNumber. Lets the
   *  hosted page render a recognisable header without a second query. */
  orderNumber: string;

  status: ConsentStatus;
  method?: ConsentMethod | null;

  /** Recipient address at the moment we asked for consent. Frozen here
   *  so a later customer-email edit on the order doesn't invalidate the
   *  evidence trail. */
  customerEmail: string;
  customerName: string;

  /** Verbatim acknowledgement statement shown to the customer. Stored so
   *  if we tweak the copy later, the record still reflects what the
   *  customer actually agreed to. */
  consentMessage: string;
  /** Subject line of the email that asked for consent (or that the
   *  customer's mailto reply was prefilled with). Useful evidence. */
  consentEmailSubject?: string | null;

  /** Required digital signature captured on the hosted consent page —
   *  the customer's typed name acts as a lightweight acknowledgement
   *  proof attached to the record. Stored nullable so we can create a
   *  REQUESTED record (no signature yet); the service enforces presence
   *  when the status transitions to RECEIVED. */
  signedName?: string | null;

  /** Snapshot of order facts at consent-request time. Stripe-style: if
   *  the agent later edits the amount, the consent still shows what the
   *  customer saw when they confirmed.
   *
   *  Pass 5h: rental-specific fields removed entirely. Universal-shape
   *  orders fill `summary` (line items recap) + `startsAt/endsAt`
   *  (from order.scheduling). Existing records with the old fields are
   *  read transparently — Mongoose just ignores fields not declared in
   *  the schema. */
  snapshot: {
    summary?: string | null;
    startsAt?: Date | null;
    endsAt?: Date | null;
    amount: number;
    currency: Currency;
    paymentLinkRef?: string | null;
  };

  /** Lifecycle timestamps. requestedAt is set at creation; receivedAt
   *  fires when the customer confirms; verifiedAt is the admin-side
   *  lock for dispute evidence. */
  requestedAt: Date;
  receivedAt?: Date | null;
  verifiedAt?: Date | null;
  verifiedBy?: {
    userId?: Types.ObjectId | null;
    name?: string | null;
  } | null;

  /** Browser fingerprint captured at receipt time (hosted page). Never
   *  surfaces in the customer-facing UI — internal evidence only. */
  receiptIp?: string | null;
  receiptUserAgent?: string | null;

  /** Free-form structured metadata: mail receipt headers, optional
   *  custom signature, manual entry notes, etc. */
  metadata?: Record<string, unknown> | null;

  createdAt: Date;
  updatedAt: Date;
}

export type PaymentConsentDocument = HydratedDocument<PaymentConsentDoc>;

const snapshotSchema = new Schema(
  {
    summary: { type: String, default: null, trim: true, maxlength: 320 },
    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, enum: CURRENCIES, required: true },
    paymentLinkRef: { type: String, default: null, maxlength: 2048 },
  },
  { _id: false },
);

const verifierSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    name: { type: String, default: null },
  },
  { _id: false },
);

const paymentConsentSchema = new Schema<PaymentConsentDoc>(
  {
    orderId: {
      type: Schema.Types.ObjectId,
      ref: "Order",
      required: true,
      index: true,
    },
    orderNumber: {
      type: String,
      required: true,
      maxlength: 32,
      index: true,
    },
    status: {
      type: String,
      enum: CONSENT_STATUSES,
      required: true,
      default: "REQUESTED",
      index: true,
    },
    method: {
      type: String,
      enum: CONSENT_METHODS,
      default: null,
    },
    customerEmail: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      maxlength: 254,
    },
    customerName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    consentMessage: {
      type: String,
      required: true,
      maxlength: 1000,
    },
    consentEmailSubject: {
      type: String,
      default: null,
      maxlength: 250,
    },
    signedName: {
      type: String,
      default: null,
      trim: true,
      maxlength: 120,
    },
    snapshot: { type: snapshotSchema, required: true },
    requestedAt: { type: Date, required: true, default: Date.now },
    receivedAt: { type: Date, default: null },
    verifiedAt: { type: Date, default: null },
    verifiedBy: { type: verifierSchema, default: null },
    receiptIp: { type: String, default: null, maxlength: 64 },
    receiptUserAgent: { type: String, default: null, maxlength: 512 },
    metadata: { type: Schema.Types.Mixed, default: null },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "payment_consents",
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

paymentConsentSchema.index({ orderId: 1, createdAt: -1 });
paymentConsentSchema.index({ status: 1, createdAt: -1 });
paymentConsentSchema.index({ customerEmail: 1, createdAt: -1 });

import { registerModel } from "./register";
export const PaymentConsent: Model<PaymentConsentDoc> =
  registerModel<PaymentConsentDoc>("PaymentConsent", paymentConsentSchema);
