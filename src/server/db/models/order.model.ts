import {
  Schema,
  type HydratedDocument,
  type Model,
  type Types,
} from "mongoose";

import {
  BOOKING_TYPES,
  BookingType,
  CONSENT_STATUSES,
  ConsentStatus,
  CURRENCIES,
  Currency,
  DISPUTE_OUTCOMES,
  DISPUTE_STATUSES,
  DisputeOutcome,
  DisputeStatus,
  ORDER_STATUSES,
  OrderStatus,
  PAYMENT_GATEWAY_KEYS,
  PaymentGatewayKey,
  RECORD_STATES,
  RecordState,
} from "@/lib/constants/enums";
import { PROVIDER_KEY_REGEX } from "@/lib/constants/providers";

export interface OrderDoc {
  orderNumber: string;
  bookingType: BookingType;
  status: OrderStatus;
  state: RecordState;

  customer: {
    name: string;
    email: string;
    phone: string;
  };
  /** Rental brand snapshot. Frozen at creation so receipts and dashboards
   *  keep showing the same brand even if the registry is later rebranded
   *  or the catalog entry is deleted. */
  provider: {
    id: string;
    name: string;
    logo: string;
    primaryColor?: string | null;
    onPrimaryColor?: string | null;
  };
  vehicle: {
    company: string;
    type: string;
    /** Optional public URL the operator provides at creation time so the
     *  customer sees the car on the order detail page, the Stripe
     *  checkout summary, and the payment-confirmation email. Stored
     *  verbatim — we don't proxy, resize, or rehost it. */
    imageUrl?: string | null;
  };
  trip: {
    pickupDate: Date;
    dropoffDate: Date;
  };
  pricing: {
    /** Stored in MAJOR units (e.g. dollars), 2-decimal precision. */
    amount: number;
    currency: Currency;
  };
  payment: {
    /** Which gateway routes this payment. Null while NOT_INITIATED —
     *  no gateway has been contacted yet. Stamped at LINK_GENERATED
     *  and frozen for the lifetime of the order. */
    gateway?: PaymentGatewayKey | null;
    /** Provider-side session id. Field name predates the multi-gateway
     *  refactor — under non-Stripe gateways this holds whatever the
     *  gateway returns as its session identifier. DTO surfaces it
     *  as the generic `paymentSessionId`. */
    stripeSessionId?: string | null;
    paymentIntentId?: string | null;
    checkoutUrl?: string | null;
    status: OrderStatus;
    paidAt?: Date | null;
    expiresAt?: Date | null;
    /** When the gateway session was created — order moves NOT_INITIATED
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
   *  list query single-collection — the full audit trail lives in the
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
   *  collection — this pointer keeps order list views single-collection
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

const vehicleSchema = new Schema(
  {
    company: { type: String, required: true, trim: true, maxlength: 80 },
    type: { type: String, required: true, trim: true, maxlength: 80 },
    imageUrl: {
      type: String,
      default: null,
      maxlength: 2048,
      trim: true,
    },
  },
  { _id: false },
);

const providerSchema = new Schema(
  {
    id: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      maxlength: 32,
      match: PROVIDER_KEY_REGEX,
      index: true,
    },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    logo: { type: String, required: true, maxlength: 200 },
    primaryColor: { type: String, default: null, maxlength: 16 },
    onPrimaryColor: { type: String, default: null, maxlength: 16 },
  },
  { _id: false },
);

const tripSchema = new Schema(
  {
    pickupDate: { type: Date, required: true },
    dropoffDate: { type: Date, required: true },
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
    status: { type: String, enum: ORDER_STATUSES, required: true },
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
    text: { type: String, required: true, maxlength: 4000, default: "" },
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
    orderNumber: {
      type: String,
      required: true,
      unique: true,
      index: true,
      maxlength: 32,
    },
    bookingType: {
      type: String,
      enum: BOOKING_TYPES,
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ORDER_STATUSES,
      required: true,
      default: "PAYMENT_PENDING",
      index: true,
    },
    state: {
      type: String,
      enum: RECORD_STATES,
      required: true,
      default: "ACTIVE",
      index: true,
    },
    customer: { type: customerSchema, required: true },
    provider: { type: providerSchema, required: true },
    vehicle: { type: vehicleSchema, required: true },
    trip: { type: tripSchema, required: true },
    pricing: { type: pricingSchema, required: true },
    payment: { type: paymentSchema, required: true },
    createdBy: { type: creatorSchema, required: true },
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
// `payment.stripeSessionId` already has `index: true, sparse: true` on the
// field definition — declaring it again here triggers a duplicate-index
// warning at startup. Keep it on the field, drop the schema-level call.

orderSchema.pre("validate", function () {
  if (this.trip?.pickupDate && this.trip?.dropoffDate) {
    if (this.trip.pickupDate >= this.trip.dropoffDate) {
      throw new Error("Drop-off date must be after pick-up date");
    }
  }
});

import { registerModel } from "./register";
export const Order: Model<OrderDoc> = registerModel<OrderDoc>(
  "Order",
  orderSchema,
);
