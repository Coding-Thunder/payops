import "server-only";

import mongoose, { Schema, Types, type Model } from "mongoose";

/**
 * Lean re-declaration of the collections this console touches. The main
 * app owns the authoritative schemas; here we mirror only the fields we
 * read/write, against the SAME collection names. Two schemas over one
 * collection is safe because Mongoose validation is per-model — we keep
 * ours permissive and never fight the main app's stricter one.
 *
 * The `model()` calls are HMR-guarded (reuse an already-registered model)
 * so dev reloads don't throw OverwriteModelError.
 */

function model<T>(name: string, schema: Schema<T>): Model<T> {
  return (mongoose.models[name] as Model<T>) ?? mongoose.model<T>(name, schema);
}

// ─── Shared collections (owned by the main app) ──────────────────────────

export interface UserDoc {
  _id: Types.ObjectId;
  name: string;
  email: string;
  passwordHash: string;
  role: "SUPER_ADMIN" | "ADMIN" | "STAFF";
  status: "ACTIVE" | "ARCHIVED" | "DISABLED";
  primaryOrgId?: Types.ObjectId | null;
  lastLoginAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
const userSchema = new Schema<UserDoc>(
  {
    name: String,
    email: { type: String, lowercase: true, trim: true },
    passwordHash: String,
    role: String,
    status: String,
    primaryOrgId: { type: Schema.Types.ObjectId, ref: "Organization" },
    lastLoginAt: Date,
  },
  { timestamps: true, versionKey: false, collection: "users", strict: false },
);
export const User = model<UserDoc>("User", userSchema);

export interface OrganizationDoc {
  _id: Types.ObjectId;
  slug: string;
  name: string;
  ownerUserId: Types.ObjectId;
  status: "PENDING" | "ACTIVE" | "SUSPENDED" | "ARCHIVED";
  verifiedAt?: Date | null;
  trialStartsAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
const organizationSchema = new Schema<OrganizationDoc>(
  {
    slug: { type: String, lowercase: true, trim: true },
    name: String,
    ownerUserId: { type: Schema.Types.ObjectId, ref: "User" },
    status: String,
    verifiedAt: { type: Date, default: null },
    trialStartsAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "organizations",
    strict: false,
  },
);
export const Organization = model<OrganizationDoc>(
  "Organization",
  organizationSchema,
);

export interface OrgMemberDoc {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  userId: Types.ObjectId;
  role: "SUPER_ADMIN" | "ADMIN" | "STAFF";
  status: "ACTIVE" | "ARCHIVED" | "DISABLED";
  invitedBy?: Types.ObjectId | null;
  joinedAt: Date;
}
const orgMemberSchema = new Schema<OrgMemberDoc>(
  {
    orgId: { type: Schema.Types.ObjectId, ref: "Organization" },
    userId: { type: Schema.Types.ObjectId, ref: "User" },
    role: String,
    status: String,
    invitedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    joinedAt: { type: Date, default: Date.now },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "org_members",
    strict: false,
  },
);
export const OrgMember = model<OrgMemberDoc>("OrgMember", orgMemberSchema);

export interface QuotationDoc {
  _id: Types.ObjectId;
  fullName?: string;
  workEmail?: string;
  companyName?: string;
  phone?: string;
  country?: string;
  useCase?: string;
  status: "PENDING" | "CONTACTED" | "QUALIFIED" | "ARCHIVED";
  source: "landing" | "contact_sales" | "email_requirements" | "waitlist";
  /** Admin-console additions (additive; the main app ignores them). */
  grantedUserId?: Types.ObjectId | null;
  grantedAt?: Date | null;
  grantedBy?: string | null;
  createdAt: Date;
  updatedAt: Date;
}
const quotationSchema = new Schema<QuotationDoc>(
  {
    fullName: String,
    workEmail: { type: String, lowercase: true, trim: true },
    companyName: String,
    phone: String,
    country: String,
    useCase: String,
    status: String,
    source: String,
    grantedUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    grantedAt: { type: Date, default: null },
    grantedBy: { type: String, default: null },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "quotations",
    strict: false,
  },
);
export const Quotation = model<QuotationDoc>("Quotation", quotationSchema);

// ─── Admin-owned collections ─────────────────────────────────────────────

export interface AdminOtpDoc {
  _id: Types.ObjectId;
  email: string;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  createdAt: Date;
}
const adminOtpSchema = new Schema<AdminOtpDoc>(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false, collection: "admin_otps" },
);
// One live OTP per email (re-issuing replaces). TTL sweeps expired rows.
adminOtpSchema.index({ email: 1 }, { unique: true });
adminOtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const AdminOtp = model<AdminOtpDoc>("AdminOtp", adminOtpSchema);

export interface AdminAuditDoc {
  _id: Types.ObjectId;
  action: string;
  actorEmail: string;
  targetType: string;
  targetId?: string | null;
  metadata?: Record<string, unknown> | null;
  ip?: string | null;
  createdAt: Date;
}
const adminAuditSchema = new Schema<AdminAuditDoc>(
  {
    action: { type: String, required: true },
    actorEmail: { type: String, required: true },
    targetType: { type: String, required: true },
    targetId: { type: String, default: null },
    metadata: { type: Schema.Types.Mixed, default: null },
    ip: { type: String, default: null },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false, collection: "admin_audit" },
);
adminAuditSchema.index({ createdAt: -1 });
adminAuditSchema.index({ actorEmail: 1, createdAt: -1 });
adminAuditSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });

// Append-only. The admin audit trail must be tamper-evident: once a row
// is written it can never be updated or deleted through the app layer.
// Every mutating query/document op is rejected; only fresh inserts pass.
const ADMIN_AUDIT_IMMUTABLE = "admin_audit is append-only and cannot be modified";
const blockAdminAuditWrite = function (): never {
  throw new Error(ADMIN_AUDIT_IMMUTABLE);
};
for (const op of [
  "updateOne",
  "updateMany",
  "replaceOne",
  "findOneAndUpdate",
  "findOneAndReplace",
  "deleteOne",
  "deleteMany",
  "findOneAndDelete",
] as const) {
  adminAuditSchema.pre(op, blockAdminAuditWrite);
}
adminAuditSchema.pre("save", function () {
  // Throwing aborts the save. Only brand-new inserts are permitted; any
  // attempt to re-save (mutate) an existing audit row is rejected.
  if (!this.isNew) throw new Error(ADMIN_AUDIT_IMMUTABLE);
});

export const AdminAudit = model<AdminAuditDoc>("AdminAudit", adminAuditSchema);

export { Types };
