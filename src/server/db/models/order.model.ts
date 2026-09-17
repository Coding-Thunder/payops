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
  PAYMENT_TIMINGS,
  PaymentTiming,
  RECORD_STATES,
  RecordState,
} from "@/lib/constants/enums";
import { PROVIDER_KEY_REGEX } from "@/lib/constants/providers";

export interface OrderDoc extends OrganizationScoped {
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
    /** Free-text rental pick-up / drop-off locations. Optional so orders
     *  created before this field keep validating. */
    pickupLocation?: string | null;
    dropoffLocation?: string | null;
  };
  pricing: {
    /** Stored in MAJOR units (e.g. dollars), 2-decimal precision.
     *  Equals the sum of PREPAID `charges` — i.e. the amount the gateway is
     *  asked to charge and the figure reconciliation/analytics read. */
    amount: number;
    currency: Currency;
  };
  /** Rental charge breakdown — source of truth for prepaid / due-at-counter
   *  / total. Empty on orders created before the charges model; those treat
   *  `pricing.amount` as a single implicit prepaid line. */
  charges: Array<{
    name: string;
    amount: number;
    timing: PaymentTiming;
  }>;
  /** Supplier confirmation number, pasted by staff after the supplier
   *  confirms. Null until entered. */
  confirmationNumber?: string | null;
  /** Snapshot of the Terms & Conditions the customer is asked to accept,
   *  frozen at creation (mirrors `policy`). */
  terms?: {
    text: string;
    version: string;
  };
  /** Customer's post-payment "I Agree" acknowledgement, captured from the
   *  confirmation email's hosted acknowledgement page. */
  termsAcknowledgement?: {
    acknowledgedAt: Date;
    ip?: string | null;
    userAgent?: string | null;
  } | null;
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
    /** Identifies the checkout the current session was created as (the
     *  gateway request key). Carried in the payment's metadata so an event
     *  that names no session can still be matched to its checkout. */
    checkoutKey?: string | null;
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
    /**
     * Append-only history of every checkout session ever opened on this
     * order, including the one currently live.
     *
     * `payment` above stays the CURRENT attempt and remains the source of
     * truth for every existing reader — the DTO, the webhook `$set`, the
     * emails, the evidence chain. Promoting this array to source-of-truth
     * would mean rewriting ~30 read sites and the DTO contract, which is the
     * payment-state-machine rewrite this work is not allowed to do.
     *
     * It exists because two things can now move the current attempt: an
     * operator switching gateway after a decline, and an operator re-pricing
     * an order whose link is already out. Both supersede a session that may
     * STILL BE PAYABLE — `failOrder` never expires a session, and a Stripe
     * decline happens inside a checkout session that stays open. Without a
     * record of which sessions are dead, a late webhook for a superseded
     * session is indistinguishable from the live one, and the money it
     * represents gets applied at the wrong amount or silently swallowed.
     */
    attempts?: Array<{
      gateway: PaymentGatewayKey;
      /** Gateway-side session id. Null if session creation itself failed. */
      sessionId?: string | null;
      checkoutKey?: string | null;
      paymentIntentId?: string | null;
      checkoutUrl?: string | null;
      /** What THIS attempt was asked to collect. Kept per-attempt so a
       *  re-price cannot retroactively change what an old link was for. */
      amount: number;
      currency: string;
      /** Terminal state of this attempt, or PAYMENT_PENDING while live. */
      status: OrderStatus;
      failureReason?: string | null;
      /** Why this attempt stopped being current. Null while it is current. */
      supersededReason?:
        | "GATEWAY_SWITCHED"
        | "REPRICED"
        | "REGENERATED"
        | "PAYMENT_HELD"
        | null;
      /** Money a gateway reported that the order did not accept (a payment
       *  on a stood-down link, or at the wrong amount). Held for an operator
       *  to reconcile; never counted as the order's payment. */
      held?: boolean;
      /** When an operator dealt with the held payment (recorded it as this
       *  order's payment, or cleared the flag after refunding it). */
      heldReviewedAt?: Date | null;
      /** Why the payment was held: on a stood-down link, an unknown one, the
       *  wrong amount, a second payment after settlement, or during a change. */
      heldKind?: string | null;
      supersededAt?: Date | null;
      createdAt: Date;
    }>;
    /**
     * Bumped every time the collectable amount changes. Threaded into the
     * gateway idempotency key so a re-priced order mints a genuinely new
     * session instead of replaying the old one at the old price.
     */
    priceRevision?: number;
    detailsChangedAt?: Date | null;
    /** Set only by a recorded offline payment. Deliberately separate from
     *  `gateway`, which is a merchant-account pin that must survive on a
     *  FAILED order so disputes still route to the right account. */
    manualMethod?: string | null;
    manualReference?: string | null;
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
    /** How the latest request asked to be paid. Null before any request. */
    collectionMethod?: "GATEWAY" | "MANUAL" | null;
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
    pickupLocation: { type: String, default: null, trim: true, maxlength: 200 },
    dropoffLocation: { type: String, default: null, trim: true, maxlength: 200 },
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

const chargeSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    amount: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: (v: number) => Number.isFinite(v) && v >= 0,
        message: "Charge amount must be a non-negative number",
      },
    },
    timing: {
      type: String,
      enum: PAYMENT_TIMINGS,
      required: true,
      default: PaymentTiming.PREPAID,
    },
  },
  { _id: false },
);

const termsSchema = new Schema(
  {
    text: { type: String, required: true, maxlength: 8000, default: "" },
    version: { type: String, required: true, maxlength: 16, default: "v1" },
  },
  { _id: false },
);

const termsAcknowledgementSchema = new Schema(
  {
    acknowledgedAt: { type: Date, required: true },
    ip: { type: String, default: null, maxlength: 64 },
    userAgent: { type: String, default: null, maxlength: 512 },
  },
  { _id: false },
);

/** One checkout session's worth of history. Append-only: nothing here is
 *  ever mutated except to stamp `superseded*` when it stops being current. */
const paymentAttemptSchema = new Schema(
  {
    gateway: { type: String, enum: PAYMENT_GATEWAY_KEYS, required: true },
    sessionId: { type: String, default: null },
    checkoutKey: { type: String, default: null, maxlength: 200 },
    paymentIntentId: { type: String, default: null },
    checkoutUrl: { type: String, default: null },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true },
    status: { type: String, enum: ORDER_STATUSES, required: true },
    failureReason: { type: String, default: null },
    supersededReason: {
      type: String,
      // REGENERATED: replaced by a fresh link at the same amount and on the
      // same gateway. Recorded so a late success on the old session is
      // recognised as superseded rather than settling the order.
      // PAYMENT_HELD: stopped because money already arrived on another link.
      enum: ["GATEWAY_SWITCHED", "REPRICED", "REGENERATED", "PAYMENT_HELD", null],
      default: null,
    },
    supersededAt: { type: Date, default: null },
    held: { type: Boolean, default: false },
    heldReviewedAt: { type: Date, default: null },
    heldKind: { type: String, default: null, maxlength: 40 },
    createdAt: { type: Date, required: true },
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
    checkoutKey: { type: String, default: null, maxlength: 200 },
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
    // Additive and defaulted, so every order written before this field
    // existed reads back as an empty history rather than undefined. No
    // migration and no backfill: an order with no recorded attempts simply
    // has no superseded session, which is exactly true of every order
    // created before a switch or a re-price was possible.
    attempts: { type: [paymentAttemptSchema], default: [] },
    priceRevision: { type: Number, default: 0, min: 0 },
    detailsChangedAt: { type: Date, default: null },
    manualMethod: { type: String, default: null, maxlength: 40 },
    manualReference: { type: String, default: null, maxlength: 120 },
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
    collectionMethod: {
      type: String,
      enum: ["GATEWAY", "MANUAL", null],
      default: null,
    },
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
    charges: { type: [chargeSchema], default: [] },
    confirmationNumber: {
      type: String,
      default: null,
      trim: true,
      maxlength: 64,
    },
    terms: { type: termsSchema, default: null },
    termsAcknowledgement: { type: termsAcknowledgementSchema, default: null },
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

import {
  organizationScope,
  type OrganizationScoped,
} from "./organization-scope";

orderSchema.plugin(organizationScope);

import { registerModel } from "./register";
export const Order: Model<OrderDoc> = registerModel<OrderDoc>(
  "Order",
  orderSchema,
);
