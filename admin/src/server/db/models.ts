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

// Email outbox (owned by the main app; the drainer there does the actual
// sending). The console reads it for Email Ops and writes limited status
// transitions (retry re-queues, cancel removes, resend re-enqueues a copy)
// — the main-app drainer then picks the change up on its next tick.
export interface PendingEmailDoc {
  _id: Types.ObjectId;
  orderId?: Types.ObjectId | null;
  orgId?: Types.ObjectId | null;
  kind: string;
  recipient: string;
  status: string; // PENDING | PROCESSING | SENT | FAILED
  attempts: number;
  nextAttemptAt?: Date | null;
  lastError?: string | null;
  sentAt?: Date | null;
  metadata?: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}
const pendingEmailSchema = new Schema<PendingEmailDoc>(
  {
    orderId: { type: Schema.Types.ObjectId, ref: "Order", default: null },
    orgId: { type: Schema.Types.ObjectId, ref: "Organization", default: null },
    kind: { type: String },
    recipient: { type: String },
    status: { type: String },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    sentAt: { type: Date, default: null },
    metadata: { type: Schema.Types.Mixed, default: null },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "pending_emails",
    strict: false,
  },
);
export const PendingEmail = model<PendingEmailDoc>(
  "PendingEmail",
  pendingEmailSchema,
);

// Main app's product audit trail (cross-tenant, append-only). Read-only
// here — the console never writes it. actor/request are read as Mixed to
// avoid re-declaring the main app's sub-schemas.
export interface AuditLogDoc {
  _id: Types.ObjectId;
  orgId?: Types.ObjectId | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  actor?: {
    userId?: Types.ObjectId | null;
    name?: string | null;
    email?: string | null;
    role?: string | null;
  } | null;
  request?: {
    ip?: string | null;
    userAgent?: string | null;
    requestId?: string | null;
  } | null;
  metadata?: Record<string, unknown> | null;
  createdAt: Date;
}
const auditLogSchema = new Schema<AuditLogDoc>(
  {
    orgId: { type: Schema.Types.ObjectId, ref: "Organization", default: null },
    action: { type: String },
    entityType: { type: String },
    entityId: { type: String, default: null },
    actor: { type: Schema.Types.Mixed, default: null },
    request: { type: Schema.Types.Mixed, default: null },
    metadata: { type: Schema.Types.Mixed, default: null },
    createdAt: { type: Date },
  },
  { versionKey: false, collection: "audit_logs", strict: false },
);
export const AuditLog = model<AuditLogDoc>("AuditLog", auditLogSchema);

// Orders (the main app's financial spine). Read-only here. Nested blocks
// (customer/pricing/payment/…) are read as Mixed to avoid re-declaring the
// main app's sub-schemas; dot-path queries (payment.paidAt, customer.email)
// still work against Mixed.
export interface OrderDoc {
  _id: Types.ObjectId;
  orgId?: Types.ObjectId | null;
  orderNumber?: string;
  status?: string;
  state?: string;
  customerId?: Types.ObjectId | null;
  customer?: { name?: string; email?: string; phone?: string } | null;
  pricing?: { amount?: number; currency?: string } | null;
  payment?: {
    gateway?: string | null;
    stripeSessionId?: string | null;
    paymentIntentId?: string | null;
    checkoutUrl?: string | null;
    status?: string | null;
    paidAt?: Date | null;
    expiresAt?: Date | null;
    initiatedAt?: Date | null;
    amountReceived?: number | null;
    receiptUrl?: string | null;
    failureReason?: string | null;
  } | null;
  createdBy?: { name?: string; email?: string } | null;
  lineItems?: Array<Record<string, unknown>>;
  consent?: { status?: string } | null;
  dispute?: { status?: string | null } | null;
  refundedAmount?: number;
  notes?: string | null;
  createdAt: Date;
  updatedAt: Date;
}
const orderSchema = new Schema<OrderDoc>(
  {
    orgId: { type: Schema.Types.ObjectId, ref: "Organization", default: null },
    orderNumber: { type: String },
    status: { type: String },
    state: { type: String },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", default: null },
    customer: { type: Schema.Types.Mixed, default: null },
    pricing: { type: Schema.Types.Mixed, default: null },
    payment: { type: Schema.Types.Mixed, default: null },
    createdBy: { type: Schema.Types.Mixed, default: null },
    lineItems: { type: Schema.Types.Mixed, default: [] },
    consent: { type: Schema.Types.Mixed, default: null },
    dispute: { type: Schema.Types.Mixed, default: null },
    refundedAmount: { type: Number, default: 0 },
    notes: { type: String, default: null },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "orders",
    strict: false,
  },
);
export const Order = model<OrderDoc>("Order", orderSchema);

// Client Profiles (the main app's Customer spine). Read-only here. Lifetime
// financials are computed on-read from orders, not stored — the denormalised
// ordersCount/first/last are cheap list-view caches.
export interface CustomerDoc {
  _id: Types.ObjectId;
  orgId?: Types.ObjectId | null;
  name?: string;
  email?: string;
  phone?: string;
  company?: string | null;
  notes?: string | null;
  tags?: string[];
  ordersCount?: number;
  firstOrderAt?: Date | null;
  lastOrderAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
const customerSchema = new Schema<CustomerDoc>(
  {
    orgId: { type: Schema.Types.ObjectId, ref: "Organization", default: null },
    name: { type: String },
    email: { type: String },
    phone: { type: String, default: "" },
    company: { type: String, default: null },
    notes: { type: String, default: null },
    tags: { type: [String], default: [] },
    ordersCount: { type: Number, default: 0 },
    firstOrderAt: { type: Date, default: null },
    lastOrderAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "customers",
    strict: false,
  },
);
export const Customer = model<CustomerDoc>("Customer", customerSchema);

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
