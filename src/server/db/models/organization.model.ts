import {
  Schema,
  type HydratedDocument,
  type Model,
  type Types,
} from "mongoose";

import { registerModel } from "./register";

/**
 * Tenant boundary for the SaaS platform. Every business-data row owns an
 * `orgId` that points at one of these. Created via the self-serve signup
 * flow (later phase) or seeded by the migration script for the legacy
 * tenant. Hard-delete is not supported, disabled orgs flip `status` to
 * SUSPENDED so audit / financial history remains queryable.
 */

export const OrgStatus = {
  /** Owner signed up but verification (email domain / manual) is pending. */
  PENDING: "PENDING",
  /** Operational, can create orders, accept payments, send emails. */
  ACTIVE: "ACTIVE",
  /** Platform-side hold (billing past-due, ToS violation). Reads continue;
   *  writes are blocked at the service layer. */
  SUSPENDED: "SUSPENDED",
  /** Soft-deleted by owner. Same blocking as SUSPENDED but signals
   *  permanent intent. */
  ARCHIVED: "ARCHIVED",
} as const;
export type OrgStatus = (typeof OrgStatus)[keyof typeof OrgStatus];
export const ORG_STATUSES = Object.values(OrgStatus) as OrgStatus[];

/** Validation regex for the public slug (used in URLs in later phases). */
export const ORG_SLUG_REGEX = /^[a-z][a-z0-9-]{1,31}$/;

export interface OrganizationDoc {
  /** URL-safe identifier. Stable, lower-case, unique platform-wide. */
  slug: string;
  /** Display name surfaced in admin UIs + emails. */
  name: string;
  /** Legal entity name for invoices/contracts. Optional during onboarding. */
  legalName?: string | null;
  /** SUPER_ADMIN of this org. Tracked for billing + escalation routing. */
  ownerUserId: Types.ObjectId;
  status: OrgStatus;
  /** First time the org was promoted from PENDING → ACTIVE. */
  verifiedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type OrganizationDocument = HydratedDocument<OrganizationDoc>;

const organizationSchema = new Schema<OrganizationDoc>(
  {
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 32,
      match: ORG_SLUG_REGEX,
    },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    legalName: { type: String, default: null, trim: true, maxlength: 200 },
    ownerUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ORG_STATUSES,
      required: true,
      default: OrgStatus.ACTIVE,
      index: true,
    },
    verifiedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "organizations",
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

export const Organization: Model<OrganizationDoc> =
  registerModel<OrganizationDoc>("Organization", organizationSchema);
