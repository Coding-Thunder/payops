import {
  Schema,
  type HydratedDocument,
  type Model,
  type Types,
} from "mongoose";

import {
  BETA_APPLICATION_STATUSES,
  BETA_USER_TYPES,
  BetaApplicationStatus,
} from "@/lib/constants/beta";

import { registerModel } from "./register";

/**
 * Beta program application — a public submission from the Join the Beta form,
 * reviewed inside the admin console. NOT a user account: no workspace exists
 * until the applicant is approved, invited, and activates via a single-use
 * token. One row per email (unique), so a re-submit never creates duplicates
 * or leaks whether an email already applied.
 *
 * The invitation token is stored HASHED (sha256 of a 32-byte random token);
 * the raw token lives only in the emailed link. Single-use (`usedAt`),
 * expiring (`expiresAt`), and bound to this application's email.
 */
export interface BetaInvite {
  tokenHash: string;
  expiresAt: Date;
  sentAt: Date | null;
  usedAt: Date | null;
}

/**
 * Where this lead came from. Captured on the visitor's FIRST page of the
 * session and submitted with the form, so a visitor who lands from an ad and
 * converts three pages later is still credited to the ad.
 *
 * Every field is untrusted client input: length-capped here and re-validated
 * at the route. None of it is used for any auth, ownership or moderation
 * decision — it is reporting data only.
 */
export interface LeadAttributionDoc {
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmTerm: string | null;
  utmContent: string | null;
  referrer: string | null;
  landingPage: string | null;
}

export interface BetaApplicationDoc {
  fullName: string;
  email: string;
  userType: string;
  businessName: string | null;
  clientsManaged: string | null;
  challengeAnswer: string | null;
  /** Marketing attribution. Null for a lead captured before this shipped. */
  attribution: LeadAttributionDoc | null;
  status: BetaApplicationStatus;
  adminNote: string | null;
  reviewedByEmail: string | null;
  reviewedAt: Date | null;
  invite: BetaInvite | null;
  /** Last invitation-send failure, surfaced in the admin panel for retry. */
  lastInviteError: string | null;
  activatedAt: Date | null;
  /** The User created at activation (audit trail; never trusted for auth). */
  activatedUserId: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

export type BetaApplicationDocument = HydratedDocument<BetaApplicationDoc>;

const betaInviteSchema = new Schema<BetaInvite>(
  {
    tokenHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    sentAt: { type: Date, default: null },
    usedAt: { type: Date, default: null },
  },
  { _id: false },
);

/** Mirrors ATTRIBUTION_FIELD_MAX in `@/lib/analytics/attribution`. */
const ATTRIBUTION_MAX = 300;

const leadAttributionSchema = new Schema<LeadAttributionDoc>(
  {
    utmSource: { type: String, default: null, trim: true, maxlength: ATTRIBUTION_MAX },
    utmMedium: { type: String, default: null, trim: true, maxlength: ATTRIBUTION_MAX },
    utmCampaign: { type: String, default: null, trim: true, maxlength: ATTRIBUTION_MAX },
    utmTerm: { type: String, default: null, trim: true, maxlength: ATTRIBUTION_MAX },
    utmContent: { type: String, default: null, trim: true, maxlength: ATTRIBUTION_MAX },
    referrer: { type: String, default: null, trim: true, maxlength: ATTRIBUTION_MAX },
    landingPage: { type: String, default: null, trim: true, maxlength: ATTRIBUTION_MAX },
  },
  { _id: false },
);

const betaApplicationSchema = new Schema<BetaApplicationDoc>(
  {
    fullName: { type: String, required: true, trim: true, maxlength: 160 },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      maxlength: 254,
    },
    userType: { type: String, required: true, enum: BETA_USER_TYPES },
    businessName: { type: String, default: null, trim: true, maxlength: 200 },
    clientsManaged: { type: String, default: null, trim: true, maxlength: 40 },
    challengeAnswer: { type: String, default: null, maxlength: 4000 },
    attribution: { type: leadAttributionSchema, default: null },
    status: {
      type: String,
      enum: BETA_APPLICATION_STATUSES,
      default: BetaApplicationStatus.PENDING,
      index: true,
    },
    adminNote: { type: String, default: null, maxlength: 4000 },
    reviewedByEmail: { type: String, default: null, lowercase: true, trim: true },
    reviewedAt: { type: Date, default: null },
    invite: { type: betaInviteSchema, default: null },
    lastInviteError: { type: String, default: null, maxlength: 500 },
    activatedAt: { type: Date, default: null },
    activatedUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true, versionKey: false, collection: "beta_applications" },
);

// One application per email (dedupe + no enumeration via re-submit).
betaApplicationSchema.index({ email: 1 }, { unique: true });
// Admin list: newest first, filterable by status.
betaApplicationSchema.index({ status: 1, createdAt: -1 });
// Activation lookup by token hash (sparse — only approved apps carry one).
betaApplicationSchema.index(
  { "invite.tokenHash": 1 },
  { sparse: true },
);

export const BetaApplication: Model<BetaApplicationDoc> =
  registerModel<BetaApplicationDoc>("BetaApplication", betaApplicationSchema);
