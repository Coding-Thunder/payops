import {
  Schema,
  type HydratedDocument,
  type Model,
  type Types,
} from "mongoose";

/**
 * Customer-facing workspace branding. Singleton (`key: "default"`) — there
 * is exactly one row for the entire deployment.
 *
 * Owns the brand name, contact details, and visual identity surfaced on
 * payment pages, confirmation emails, and the Stripe checkout product
 * description. Operator-facing chrome (`APP_NAME`, admin console logo)
 * stays env-driven and intentionally lives outside this doc.
 */
export const BRANDING_KEY = "default" as const;

export interface BrandingDoc {
  key: string;
  brandName: string;
  supportEmail: string;
  supportPhone: string;
  /** Public path to the brand mark (e.g. `/branding/logo-ab12.png`).
   *  Empty string disables the logo on customer surfaces. */
  logo: string;
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
    key: {
      type: String,
      required: true,
      unique: true,
      default: BRANDING_KEY,
    },
    brandName: { type: String, required: true, trim: true, maxlength: 80 },
    supportEmail: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      maxlength: 254,
    },
    supportPhone: { type: String, required: true, trim: true, maxlength: 32 },
    logo: { type: String, default: "", maxlength: 200 },
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

import { registerModel } from "./register";
export const Branding: Model<BrandingDoc> = registerModel<BrandingDoc>(
  "Branding",
  brandingSchema,
);
