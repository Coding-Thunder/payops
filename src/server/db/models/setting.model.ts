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

/**
 * Built-in FLIGHT terms — the fallback for an organization that has not
 * entered its own (Admin → Settings → Flight terms). Deliberately
 * brand-neutral and NOT stored on the Settings singleton: a deployment-wide
 * flight text would let one brand's legal wording reach another brand's
 * flights. Written for the flight money model — the service charge is the
 * only amount collected online; the airline fare is the airline's.
 */
export const DEFAULT_FLIGHT_TERMS_AND_CONDITIONS = [
  "This booking is arranged on your behalf with the airline(s) shown in your itinerary. Each flight is operated under the operating airline's conditions of carriage and the fare rules of your ticket.",
  "The service charge shown is the only amount collected through this payment. If your card is authorized (held) rather than charged, the service charge is collected only once your booking is confirmed. Where an airline fare is shown, it forms part of your total booking value but is not included in this payment.",
  "Please make sure every passenger's name matches their passport or government-issued photo ID exactly. Name corrections may be restricted or charged by the airline.",
  "Each passenger is responsible for holding valid travel documents — passport, visas, transit visas and any health documentation — for every country on the itinerary, including connection points.",
  "Check-in, boarding, baggage allowances, seat assignments and optional extras are governed by the operating airline. Please allow enough time at the airport for check-in and security.",
  "Flight schedules can change. If an airline changes or cancels a flight, we will help you with the options the airline offers.",
  "Changes and cancellations are subject to your ticket's fare rules and the cancellation policy provided with your booking.",
].join("\n");

/** Built-in FLIGHT cancellation policy. Same rules as the flight terms. */
export const DEFAULT_FLIGHT_CANCELLATION_POLICY = [
  "Changes and cancellations to airline tickets are governed by the fare rules of the ticket issued. Many fares are non-refundable or carry airline change fees.",
  "Where the fare rules allow a refund, the refundable amount is set by the airline and returned once the airline releases it.",
  "Requests to change or cancel must be made before the scheduled departure of the first affected flight. A missed flight may forfeit the rest of the itinerary.",
  "To request a change or cancellation, reply to this email or contact our support team using the details below.",
].join("\n");

/** Version label frozen onto an order that used a built-in flight text. */
export const DEFAULT_FLIGHT_LEGAL_VERSION = "v1";

/**
 * Built-in HOTEL terms — the fallback for an organization that sells hotel
 * stays but has not entered its own (Admin → Settings → Hotel terms). The
 * same reasons as the flight text: brand-neutral, never on the Settings
 * singleton, and never the car rental text, whose licence/vehicle clauses do
 * not describe a hotel stay.
 *
 * Frozen permanently onto every hotel order that uses it, so it says only
 * what a hotel order shows and does: the destination, dates, rooms and
 * guests, a property that may still be unnamed, the amount paid online (the
 * emails' "You pay today" / "Amount paid online"), any "Amount due at the
 * property", holds collected on confirmation, and refunds of the online
 * amount to the original payment method.
 */
export const DEFAULT_HOTEL_TERMS_AND_CONDITIONS = [
  "This booking is arranged on your behalf for the destination, dates, rooms and guests shown in your reservation, at the property named there or the one we confirm with you. Your stay is provided by that property under its own terms and house rules.",
  "The amount you pay online is the only amount collected through this payment. If your card is authorized (held) rather than charged, it is collected only once your booking is confirmed. Any amount shown as due at the property, and any local taxes or fees the property charges, are paid to the property directly.",
  "Check-in and check-out times, identification requirements, security deposits and incidental charges are set by the property. The lead guest may be asked to present a valid photo ID and a payment card at check-in.",
  "Changes to the dates, rooms or guests may change the price and are subject to availability.",
  "Changes and cancellations are subject to the cancellation policy provided with your booking.",
].join("\n");

/** Built-in HOTEL cancellation policy. Same rules as the hotel terms. */
export const DEFAULT_HOTEL_CANCELLATION_POLICY = [
  "Whether a booking can be changed or cancelled, and at what cost, depends on the rate booked. Some rates are non-refundable.",
  "Where a refund is due, it is made to your original payment method and is limited to the amount you paid online.",
  "Any amount due at the property — including any charge the property makes for a no-show — is set and collected by the property.",
  "To request a change or cancellation, reply to this email or contact our support team using the details below.",
].join("\n");

/** Version label frozen onto an order that used a built-in hotel text. */
export const DEFAULT_HOTEL_LEGAL_VERSION = "v1";

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
