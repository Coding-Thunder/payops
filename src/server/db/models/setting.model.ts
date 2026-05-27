import {
  Schema,
  type HydratedDocument,
  type Model,
} from "mongoose";

import {
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

export interface SettingDoc {
  /** Legacy singleton key (`"default"`). Kept during migration so the
   *  pre-multi-tenant `findOne({ key: "default" })` reads keep working. */
  key: string;
  /** Tenant boundary. Nullable during migration window; once every
   *  Setting row has been backfilled, `findOne({ orgId })` becomes the
   *  canonical lookup and `key` retires. */
  orgId?: import("mongoose").Types.ObjectId | null;
  paymentExpiryHours: number;
  orderPrefix: string;
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
  updatedBy?: Schema.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

export type SettingDocument = HydratedDocument<SettingDoc>;

const settingSchema = new Schema<SettingDoc>(
  {
    // Legacy singleton selector. Pre-multi-tenant code paths still write
    // `key: "default"` via `ensureSettingsDocument`; per-org rows omit
    // the field entirely and rely on `orgId` for uniqueness. Field-level
    // `unique: true` is removed in favour of the partial-unique index
    // declared below so the migration window can carry both shapes
    // without collision.
    key: { type: String, default: undefined, maxlength: 32 },
    orgId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      default: null,
    },
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

// Exactly one Setting row per organization. Partial filter so legacy
// rows that haven't been backfilled with orgId yet don't collide.
settingSchema.index(
  { orgId: 1 },
  {
    unique: true,
    partialFilterExpression: { orgId: { $type: "objectId" } },
    name: "settings_orgId_unique",
  },
);
// Legacy {key:"default"} singleton — kept unique while migration code
// still upserts via key. Partial filter exempts per-org rows that
// omit the field entirely.
settingSchema.index(
  { key: 1 },
  {
    unique: true,
    partialFilterExpression: { key: { $type: "string" } },
    name: "settings_key_unique",
  },
);

import { registerModel } from "./register";
export const Setting: Model<SettingDoc> = registerModel<SettingDoc>(
  "Setting",
  settingSchema,
);
