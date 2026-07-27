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

export interface BetaApplicationDoc {
  fullName: string;
  email: string;
  userType: string;
  businessName: string | null;
  clientsManaged: string | null;
  challengeAnswer: string | null;
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
