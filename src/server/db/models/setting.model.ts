import {
  Schema,
  type HydratedDocument,
  type Model,
} from "mongoose";

import {
  BOOKING_TYPES,
  BookingType,
  CONSENT_MODES,
  ConsentMode,
  CURRENCIES,
  Currency,
} from "@/lib/constants/enums";

/** Single-document settings collection. Identified by `key: "default"`. */
export const SETTINGS_KEY = "default" as const;

/**
 * Default cancellation/refund policy. Used as the seed value the first time
 * the settings document is created and shown to admins so they have a
 * reasonable starting point to edit from.
 */
export const DEFAULT_CANCELLATION_POLICY = [
  "Cancellations made more than 24 hours before pick-up are eligible for a full refund.",
  "Cancellations made within 24 hours of pick-up forfeit the deposit.",
  "Modification fees (date or vehicle changes) are non-refundable once paid.",
  "Refunds are processed within 5-10 business days to the original payment method.",
  "To request a refund, reply to this email or contact our support team using the details below.",
].join("\n");

/**
 * Default copy for the customer acknowledgement statement. Intentionally
 * short, calm, and free of legalese — this is operational evidence, not
 * an enterprise contract.
 */
export const DEFAULT_CONSENT_MESSAGE =
  "I confirm that I understand and agree to proceed with this payment and booking.";

/**
 * Default rental Terms & Conditions. Snapshotted onto each order at creation
 * and rendered (with an "I Agree" action) in the confirmation email. Admins
 * edit this from /admin/settings; the customer-provided T&C drops in here.
 */
export const DEFAULT_TERMS_AND_CONDITIONS = [
  "The prepaid amount is charged today to secure your reservation. Any balance shown as 'due at counter' is collected by the rental location at pick-up.",
  "A valid driver's licence, the payment card used, and any required deposit must be presented at the counter at pick-up.",
  "The named driver must meet the rental location's minimum age and licence-held requirements. Additional drivers must be registered at the counter.",
  "The vehicle must be returned at the agreed drop-off location, on or before the return date/time, with the same fuel level, or additional charges may apply.",
  "Tolls, traffic fines, fuel, and optional extras are the renter's responsibility and may be charged after the rental.",
  "Cancellation and refund terms follow the cancellation policy provided with your booking.",
].join("\n");

export interface SettingDoc {
  key: string;
  paymentExpiryHours: number;
  orderPrefix: string;
  allowedBookingTypes: BookingType[];
  defaultCurrency: Currency;
  /** @deprecated support contact moved to the Branding doc. Field is kept
   *  on the schema for read-back compat with old documents. */
  supportEmail?: string;
  /** @deprecated support contact moved to the Branding doc. */
  supportPhone?: string;
  successRedirectUrl: string;
  cancelRedirectUrl: string;
  /** Free-form cancellation/refund policy text shown in confirmation emails
   *  and snapshotted onto each order at creation for dispute evidence. */
  cancellationPolicy: string;
  /** Monotonically-increasing version string ("v1", "v2", …) bumped whenever
   *  the policy text changes. Snapshotted onto the order so disputes can
   *  point to the exact policy version the customer paid against. */
  cancellationPolicyVersion: string;
  /** Operational policy for pre-payment consent. ADVISORY is the safe
   *  default — we capture consent but never block payment. Tighten only
   *  when ops/legal explicitly opt in. */
  consentMode: ConsentMode;
  /** Customer-facing acknowledgement copy. Editable by admins; rendered
   *  verbatim into emails and the hosted consent page. */
  consentMessage: string;
  /** Rental Terms & Conditions text. Snapshotted onto each order at creation
   *  and shown (with an "I Agree" action) in the confirmation email. */
  termsAndConditions: string;
  /** Auto-bumped version string for the T&C, mirroring the policy version so
   *  an order can prove which T&C revision the customer accepted. */
  termsVersion: string;
  updatedBy?: Schema.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

export type SettingDocument = HydratedDocument<SettingDoc>;

const settingSchema = new Schema<SettingDoc>(
  {
    key: { type: String, required: true, unique: true, default: SETTINGS_KEY },
    paymentExpiryHours: {
      type: Number,
      required: true,
      min: 1,
      max: 24 * 30,
      default: 24,
    },
    orderPrefix: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      maxlength: 6,
      default: "ORD",
    },
    allowedBookingTypes: {
      type: [String],
      enum: BOOKING_TYPES,
      required: true,
      default: () => [...BOOKING_TYPES],
    },
    defaultCurrency: {
      type: String,
      enum: CURRENCIES,
      required: true,
      default: "USD",
    },
    // supportEmail / supportPhone were migrated to the Branding doc.
    // Keep the columns nullable on the schema so we can still load old
    // settings rows; reading happens via Branding now.
    supportEmail: { type: String, required: false, lowercase: true },
    supportPhone: { type: String, required: false },
    successRedirectUrl: { type: String, required: true },
    cancelRedirectUrl: { type: String, required: true },
    cancellationPolicy: {
      type: String,
      required: true,
      default: DEFAULT_CANCELLATION_POLICY,
      maxlength: 4000,
    },
    cancellationPolicyVersion: {
      type: String,
      required: true,
      default: "v1",
      maxlength: 16,
    },
    consentMode: {
      type: String,
      enum: CONSENT_MODES,
      required: true,
      default: "ADVISORY",
    },
    consentMessage: {
      type: String,
      required: true,
      default: DEFAULT_CONSENT_MESSAGE,
      maxlength: 1000,
    },
    termsAndConditions: {
      type: String,
      required: true,
      default: DEFAULT_TERMS_AND_CONDITIONS,
      maxlength: 8000,
    },
    termsVersion: {
      type: String,
      required: true,
      default: "v1",
      maxlength: 16,
    },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "settings",
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

import { registerModel } from "./register";
export const Setting: Model<SettingDoc> = registerModel<SettingDoc>(
  "Setting",
  settingSchema,
);
