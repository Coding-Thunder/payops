import {
  Schema,
  type HydratedDocument,
  type Model,
  type Types,
} from "mongoose";

/**
 * Customer-facing workspace branding. Singleton (`key: "default"`), there
 * is exactly one row for the entire deployment.
 *
 * Owns the brand name, contact details, and visual identity surfaced on
 * payment pages, confirmation emails, and the Stripe checkout product
 * description. Operator-facing chrome (`APP_NAME`, admin console logo)
 * stays env-driven and intentionally lives outside this doc.
 */
export const BRANDING_KEY = "default" as const;

export interface BrandingDoc {
  /** Legacy singleton key. Kept during migration so existing
   *  `findOne({ key: "default" })` calls still work. Retires once every
   *  Branding row carries `orgId`. */
  key: string;
  /** Tenant boundary. Nullable during migration window. */
  orgId?: Types.ObjectId | null;
  brandName: string;
  supportEmail: string;
  supportPhone: string;
  /** Friendly From address the tenant wants on outbound transactional
   *  emails. Stored as a full RFC-5322-style header value or bare
   *  address; the sender uses it as the From mailbox + friendly name.
   *  Empty falls back to the platform default (EMAIL_FROM env), which
   *  is the right behaviour for tenants who haven't completed SPF/DKIM
   *  for their own domain. */
  senderEmail: string;
  /** Public URL to the brand mark. New uploads land at
   *  `/api/branding/logo/{orgId}/{hash}.{ext}` and are served by the
   *  per-org logo route handler from `logoBytes` below. Legacy values
   *  starting with `/branding/...` are disk-served files from the
   *  pre-Mongo era, they continue to work as long as the file is on
   *  disk, but are replaced by Mongo-backed URLs on the next upload.
   *  Empty string disables the logo on customer surfaces. */
  logo: string;
  /** Raw bytes for the brand mark, stored on the Branding doc itself so
   *  the file survives deploys and is shared across app instances. Only
   *  populated when `logo` is a Mongo-backed URL. Capped at 512 KB at
   *  the upload service. Served by the public per-org route handler. */
  logoBytes?: Buffer | null;
  /** MIME type matched against bytesMatchMime sniffing at upload time. */
  logoMimeType?: string | null;
  primaryColor: string;
  /** Optional one-liner shown on /pay/success + /pay/cancelled below
   *  the brand name. Empty string hides it. */
  footerTagline: string;
  updatedBy?: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

export type BrandingDocument = HydratedDocument<BrandingDoc>;

const brandingSchema = new Schema<BrandingDoc>(
  {
    // Legacy singleton selector. New per-org rows omit `key` entirely
    // and rely on `orgId` for uniqueness. Field-level `unique: true`
    // removed in favour of the partial-unique declared below.
    key: { type: String, default: undefined, maxlength: 32 },
    orgId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      default: null,
    },
    brandName: { type: String, required: true, trim: true, maxlength: 80 },
    supportEmail: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      maxlength: 254,
    },
    supportPhone: { type: String, default: "", trim: true, maxlength: 32 },
    senderEmail: { type: String, default: "", trim: true, maxlength: 254 },
    logo: { type: String, default: "", maxlength: 200 },
    logoBytes: { type: Buffer, default: null, select: false },
    logoMimeType: { type: String, default: null, maxlength: 64 },
    primaryColor: {
      type: String,
      required: true,
      match: /^#[0-9A-Fa-f]{6}$/,
      default: "#0B1220",
    },
    footerTagline: { type: String, default: "", maxlength: 200, trim: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "branding",
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

// One Branding row per organization.
brandingSchema.index(
  { orgId: 1 },
  {
    unique: true,
    partialFilterExpression: { orgId: { $type: "objectId" } },
    name: "branding_orgId_unique",
  },
);
// Legacy {key:"default"} singleton, partial-unique exempts per-org
// rows that omit `key`.
brandingSchema.index(
  { key: 1 },
  {
    unique: true,
    partialFilterExpression: { key: { $type: "string" } },
    name: "branding_key_unique",
  },
);

import { registerModel } from "./register";
export const Branding: Model<BrandingDoc> = registerModel<BrandingDoc>(
  "Branding",
  brandingSchema,
);
