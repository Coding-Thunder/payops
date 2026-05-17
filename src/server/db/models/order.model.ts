import {
  Schema,
  type HydratedDocument,
  type Model,
  type Types,
} from "mongoose";

import {
  BOOKING_TYPES,
  BookingType,
  CURRENCIES,
  Currency,
  ORDER_STATUSES,
  OrderStatus,
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
    stripeSessionId?: string | null;
    paymentIntentId?: string | null;
    checkoutUrl?: string | null;
    status: OrderStatus;
    paidAt?: Date | null;
    expiresAt?: Date | null;
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
    stripeSessionId: { type: String, default: null, index: true, sparse: true },
    paymentIntentId: { type: String, default: null, index: true, sparse: true },
    checkoutUrl: { type: String, default: null },
    status: { type: String, enum: ORDER_STATUSES, required: true },
    paidAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
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
