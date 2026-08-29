import {
  Schema,
  type HydratedDocument,
  type Model,
  type Types,
} from "mongoose";

import {
  BOOKING_STATUSES,
  BOOKING_TYPES,
  BookingStatus,
  BookingType,
  CAPTURE_MODES,
  CaptureMode,
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
  PAYMENT_CAPTURE_STATUSES,
  PaymentCaptureStatus,
  RECORD_STATES,
  RecordState,
  SERVICE_TYPES,
  ServiceType,
} from "@/lib/constants/enums";
import { PROVIDER_KEY_REGEX } from "@/lib/constants/providers";

export interface OrderDoc extends OrganizationScoped {
  orderNumber: string;
  bookingType: BookingType;
  /** WHAT was bought. Defaults to CAR_RENTAL on both write and hydration,
   *  so every order written before this field existed reads back as the
   *  car rental it has always been. */
  serviceType: ServiceType;
  status: OrderStatus;
  state: RecordState;
  /** BOOKING lifecycle, distinct from the payment lifecycle in `status`.
   *  NULL on every automatic-capture order — i.e. on every order both
   *  incumbent brands have ever created. */
  bookingStatus?: BookingStatus | null;

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
  /** CAR_RENTAL only. Null on FLIGHT / HOTEL orders. */
  vehicle?: {
    company: string;
    type: string;
    /** Optional public URL the operator provides at creation time so the
     *  customer sees the car on the order detail page, the Stripe
     *  checkout summary, and the payment-confirmation email. Stored
     *  verbatim — we don't proxy, resize, or rehost it. */
    imageUrl?: string | null;
  } | null;
  /** CAR_RENTAL only. Null on FLIGHT / HOTEL orders. */
  trip?: {
    pickupDate: Date;
    dropoffDate: Date;
    /** Free-text rental pick-up / drop-off locations. Optional so orders
     *  created before this field keep validating. */
    pickupLocation?: string | null;
    dropoffLocation?: string | null;
  } | null;
  /** FLIGHT only. A booking REQUEST — this platform holds no airline
   *  inventory and talks to no GDS. Null on every other service type. */
  flight?: {
    tripType: "ONE_WAY" | "ROUND_TRIP";
    airline?: string | null;
    flightNumber?: string | null;
    origin: string;
    destination: string;
    departureDate: Date;
    departureTimePreference?: string | null;
    returnDate?: Date | null;
    returnTimePreference?: string | null;
    cabinClass: string;
    passengers: { adults: number; children: number; infants: number };
    passengerNotes?: string | null;
    pnr?: string | null;
  } | null;
  /** HOTEL only. A booking REQUEST — no hotel inventory API is involved.
   *  Null on every other service type. */
  hotel?: {
    destination: string;
    propertyName?: string | null;
    checkInDate: Date;
    checkOutDate: Date;
    rooms: number;
    guests: { adults: number; children: number };
    roomPreference?: string | null;
    guestNotes?: string | null;
    confirmationCode?: string | null;
  } | null;
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
     * Manual-capture state. NULL means "automatic capture, not
     * applicable" — which is the state of every order both incumbent
     * brands have ever created, and needs no backfill. Populated only
     * when the owning organization runs `captureMode: MANUAL`.
     */
    capture?: {
      method: CaptureMode;
      status: PaymentCaptureStatus;
      authorizedAt?: Date | null;
      /** Major units, mirroring `pricing.amount`. */
      amountAuthorized?: number | null;
      /** When the gateway will release the hold on its own if we never
       *  capture. Stripe is ~7 days. */
      captureExpiresAt?: Date | null;
      capturedAt?: Date | null;
      amountCaptured?: number | null;
      cancelledAt?: Date | null;
      cancelReason?: string | null;
      lastError?: string | null;
    } | null;
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
    pickupLocation: { type: String, default: null, trim: true, maxlength: 200 },
    dropoffLocation: { type: String, default: null, trim: true, maxlength: 200 },
  },
  { _id: false },
);

const flightPassengersSchema = new Schema(
  {
    adults: { type: Number, required: true, min: 1, max: 9, default: 1 },
    children: { type: Number, required: true, min: 0, max: 9, default: 0 },
    infants: { type: Number, required: true, min: 0, max: 9, default: 0 },
  },
  { _id: false },
);

/**
 * Flight booking REQUEST. Deliberately not an airline/GDS integration —
 * this platform holds no inventory. It captures enough for an operator to
 * source the fare manually and quote it back.
 */
const flightSchema = new Schema(
  {
    tripType: {
      type: String,
      enum: ["ONE_WAY", "ROUND_TRIP"],
      required: true,
      default: "ONE_WAY",
    },
    airline: { type: String, default: null, trim: true, maxlength: 80 },
    flightNumber: { type: String, default: null, trim: true, maxlength: 16 },
    origin: { type: String, required: true, trim: true, maxlength: 120 },
    destination: { type: String, required: true, trim: true, maxlength: 120 },
    departureDate: { type: Date, required: true },
    departureTimePreference: {
      type: String,
      default: null,
      trim: true,
      maxlength: 40,
    },
    returnDate: { type: Date, default: null },
    returnTimePreference: {
      type: String,
      default: null,
      trim: true,
      maxlength: 40,
    },
    cabinClass: {
      type: String,
      required: true,
      trim: true,
      maxlength: 40,
      default: "ECONOMY",
    },
    passengers: {
      type: flightPassengersSchema,
      required: true,
      default: () => ({ adults: 1, children: 0, infants: 0 }),
    },
    passengerNotes: { type: String, default: null, maxlength: 2000 },
    /** Airline record locator, pasted by the operator once ticketed. */
    pnr: { type: String, default: null, trim: true, maxlength: 32 },
  },
  { _id: false },
);

const hotelGuestsSchema = new Schema(
  {
    adults: { type: Number, required: true, min: 1, max: 20, default: 1 },
    children: { type: Number, required: true, min: 0, max: 20, default: 0 },
  },
  { _id: false },
);

/** Hotel booking REQUEST. No hotel inventory API is involved. */
const hotelSchema = new Schema(
  {
    destination: { type: String, required: true, trim: true, maxlength: 120 },
    propertyName: { type: String, default: null, trim: true, maxlength: 160 },
    checkInDate: { type: Date, required: true },
    checkOutDate: { type: Date, required: true },
    rooms: { type: Number, required: true, min: 1, max: 20, default: 1 },
    guests: {
      type: hotelGuestsSchema,
      required: true,
      default: () => ({ adults: 1, children: 0 }),
    },
    roomPreference: { type: String, default: null, trim: true, maxlength: 200 },
    guestNotes: { type: String, default: null, maxlength: 2000 },
    confirmationCode: { type: String, default: null, trim: true, maxlength: 64 },
  },
  { _id: false },
);

/**
 * Authorization bookkeeping for manual capture.
 *
 * Attached at the root of `payment` with `default: null`, exactly the way
 * `dispute` hangs off the order — so an automatic-capture order carries no
 * such sub-document and every query, projection and DTO for the two
 * incumbent brands is byte-identical to what it was.
 */
const paymentCaptureSchema = new Schema(
  {
    method: { type: String, enum: CAPTURE_MODES, required: true },
    status: {
      type: String,
      enum: PAYMENT_CAPTURE_STATUSES,
      required: true,
    },
    authorizedAt: { type: Date, default: null },
    amountAuthorized: { type: Number, default: null, min: 0 },
    captureExpiresAt: { type: Date, default: null },
    capturedAt: { type: Date, default: null },
    amountCaptured: { type: Number, default: null, min: 0 },
    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, default: null, maxlength: 200 },
    lastError: { type: String, default: null, maxlength: 512 },
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
    capture: { type: paymentCaptureSchema, default: null },
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
    /**
     * REQUIRED-WITH-DEFAULT is deliberate. Mongoose applies the default when
     * hydrating a stored document that has no such key, so every order
     * written before this field existed validates and re-saves as
     * CAR_RENTAL — which is exactly what it is. The backfill script then
     * writes the value to disk so QUERIES match too; correctness does not
     * depend on the backfill having run, only query completeness does.
     */
    serviceType: {
      type: String,
      enum: SERVICE_TYPES,
      required: true,
      default: ServiceType.CAR_RENTAL,
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
    /** Booking lifecycle. Null unless the order runs on manual capture. */
    bookingStatus: {
      type: String,
      enum: BOOKING_STATUSES,
      default: null,
      index: true,
    },
    customer: { type: customerSchema, required: true },
    provider: { type: providerSchema, required: true },
    /**
     * Car-rental payload. The predicate is TRUE for every document that
     * existed before `serviceType` was introduced (they hydrate as
     * CAR_RENTAL), so this validates identically to the previous
     * `required: true` for both incumbent brands.
     */
    vehicle: {
      type: vehicleSchema,
      default: null,
      required: function (this: OrderDoc) {
        return (this.serviceType ?? ServiceType.CAR_RENTAL) ===
          ServiceType.CAR_RENTAL;
      },
    },
    trip: {
      type: tripSchema,
      default: null,
      required: function (this: OrderDoc) {
        return (this.serviceType ?? ServiceType.CAR_RENTAL) ===
          ServiceType.CAR_RENTAL;
      },
    },
    flight: {
      type: flightSchema,
      default: null,
      required: function (this: OrderDoc) {
        return this.serviceType === ServiceType.FLIGHT;
      },
    },
    hotel: {
      type: hotelSchema,
      default: null,
      required: function (this: OrderDoc) {
        return this.serviceType === ServiceType.HOTEL;
      },
    },
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
orderSchema.index({ organizationId: 1, serviceType: 1, createdAt: -1 });
// Powers "which authorizations are about to lapse". Sparse because
// `payment.capture` is null on every automatic-capture order, so this index
// costs nothing for the two incumbent brands.
orderSchema.index(
  { "payment.capture.status": 1, "payment.capture.captureExpiresAt": 1 },
  { sparse: true },
);
// `payment.stripeSessionId` already has `index: true, sparse: true` on the
// field definition — declaring it again here triggers a duplicate-index
// warning at startup. Keep it on the field, drop the schema-level call.

/**
 * Cross-field date ordering, per service type.
 *
 * The CAR_RENTAL branch is the ORIGINAL rule, unchanged and still reached
 * by every document that has no `serviceType` stored. FLIGHT and HOTEL get
 * their own rules because the rental rule is wrong for them: a one-way
 * flight has no return leg at all, and a same-day return is legitimate,
 * whereas `dropoff > pickup` would reject both.
 */
orderSchema.pre("validate", function () {
  const serviceType = this.serviceType ?? ServiceType.CAR_RENTAL;

  if (serviceType === ServiceType.FLIGHT) {
    if (this.flight?.tripType === "ROUND_TRIP") {
      if (!this.flight.returnDate) {
        throw new Error("Return date is required for a round trip");
      }
      if (this.flight.returnDate < this.flight.departureDate) {
        throw new Error("Return date must not be before the departure date");
      }
    }
    return;
  }

  if (serviceType === ServiceType.HOTEL) {
    if (this.hotel?.checkInDate && this.hotel?.checkOutDate) {
      if (this.hotel.checkInDate >= this.hotel.checkOutDate) {
        throw new Error("Check-out date must be after check-in date");
      }
    }
    return;
  }

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
