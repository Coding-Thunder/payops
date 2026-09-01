import {
  Schema,
  type HydratedDocument,
  type Model,
  type Types,
} from "mongoose";

import {
  BOOKING_TYPES,
  BookingType,
  CONSENT_METHODS,
  CONSENT_STATUSES,
  ConsentMethod,
  ConsentStatus,
  CURRENCIES,
  Currency,
  PAYMENT_TIMINGS,
  PaymentTiming,
  SERVICE_TYPES,
  ServiceType,
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

export interface PaymentConsentDoc extends OrganizationScoped {
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
   *  the agent later edits the amount or the provider, the consent still
   *  shows what the customer saw when they confirmed. */
  snapshot: {
    bookingType: BookingType;
    /** WHAT was booked. Null on records written before this field existed —
     *  read as CAR_RENTAL, which is what they are. It exists so the
     *  customer-facing page can LABEL the three rental-shaped slots below
     *  correctly instead of telling a cruise passenger about a "Vehicle". */
    serviceType?: ServiceType | null;
    provider: string;
    /** The item, whatever the service: a vehicle, a route, or a sailing.
     *  Field name is historical — renaming it would rewrite the meaning of
     *  every stored consent record and fork the append-only chain. */
    vehicle: string;
    pickupDate: Date;
    dropoffDate: Date;
    pickupLocation?: string | null;
    dropoffLocation?: string | null;
    /** `amount` is the prepaid/online figure. The full breakdown lives in
     *  `charges` + `dueAtCounter` + `total`. */
    amount: number;
    currency: Currency;
    charges?: Array<{ name: string; amount: number; timing: PaymentTiming }>;
    dueAtCounter?: number;
    total?: number;
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

const snapshotChargeSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    amount: { type: Number, required: true, min: 0 },
    timing: { type: String, enum: PAYMENT_TIMINGS, required: true },
  },
  { _id: false },
);

const snapshotSchema = new Schema(
  {
    bookingType: { type: String, enum: BOOKING_TYPES, required: true },
    /**
     * OPTIONAL and null on every consent record written before this field
     * existed; readers default to CAR_RENTAL, which is what those records
     * are.
     *
     * The three rental-shaped fields below (`vehicle`, `pickupDate`,
     * `dropoffDate`) stay REQUIRED and are synthesised for a flight or a
     * cruise, so the append-only consent chain keeps exactly one shape.
     */
    serviceType: { type: String, enum: SERVICE_TYPES, default: null },
    provider: { type: String, required: true, trim: true, maxlength: 120 },
    vehicle: { type: String, required: true, trim: true, maxlength: 160 },
    pickupDate: { type: Date, required: true },
    dropoffDate: { type: Date, required: true },
    pickupLocation: { type: String, default: null, trim: true, maxlength: 200 },
    dropoffLocation: { type: String, default: null, trim: true, maxlength: 200 },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, enum: CURRENCIES, required: true },
    charges: { type: [snapshotChargeSchema], default: [] },
    dueAtCounter: { type: Number, default: 0, min: 0 },
    total: { type: Number, default: 0, min: 0 },
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

import {
  organizationScope,
  type OrganizationScoped,
} from "./organization-scope";

paymentConsentSchema.plugin(organizationScope);

import { registerModel } from "./register";
export const PaymentConsent: Model<PaymentConsentDoc> =
  registerModel<PaymentConsentDoc>("PaymentConsent", paymentConsentSchema);
