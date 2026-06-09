import {
  Schema,
  type HydratedDocument,
  type Model,
} from "mongoose";

/**
 * Inbound enterprise quotation request, captured from the marketing
 * landing page's `Request Quotation` form. We persist every submission
 * so sales can triage in-app and operations has a permanent record
 * even if the notification email is lost.
 *
 * Stripped down on purpose: there is no PII gating, no encryption, no
 * lifecycle, this is a B2B contact form, not a financial record.
 */
export interface QuotationDoc {
  fullName: string;
  companyName: string;
  workEmail: string;
  phone: string;
  country: string;
  expectedVolume: string;
  preferredGateway: string;
  currentStack: string;
  useCase: string;
  timeline: string;
  customRequirements: string;
  notes: string;
  /** Status tracked by sales, pending until someone picks it up. */
  status: "PENDING" | "CONTACTED" | "QUALIFIED" | "ARCHIVED";
  source:
    | "landing"
    | "contact_sales"
    | "email_requirements"
    | "waitlist";
  /** Email delivery state for the internal notification, separate from
   *  the record itself so a transient SMTP outage never drops the
   *  inbound lead. */
  notificationStatus: "SENT" | "FAILED" | "SKIPPED";
  notificationMessageId: string | null;
  notificationError: string | null;
  /** Captured at submission time for spam triage. Never used for any
   *  customer-facing logic. */
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type QuotationDocument = HydratedDocument<QuotationDoc>;

const quotationSchema = new Schema<QuotationDoc>(
  {
    fullName: { type: String, required: true, trim: true, maxlength: 120 },
    companyName: { type: String, required: true, trim: true, maxlength: 160 },
    workEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 254,
      index: true,
    },
    phone: { type: String, required: true, trim: true, maxlength: 32 },
    country: { type: String, required: true, trim: true, maxlength: 80 },
    expectedVolume: {
      type: String,
      required: true,
      trim: true,
      maxlength: 64,
    },
    preferredGateway: { type: String, default: "", trim: true, maxlength: 120 },
    currentStack: { type: String, default: "", trim: true, maxlength: 400 },
    useCase: { type: String, default: "", trim: true, maxlength: 2000 },
    timeline: { type: String, default: "", trim: true, maxlength: 80 },
    customRequirements: {
      type: String,
      default: "",
      trim: true,
      maxlength: 4000,
    },
    notes: { type: String, default: "", trim: true, maxlength: 4000 },
    status: {
      type: String,
      enum: ["PENDING", "CONTACTED", "QUALIFIED", "ARCHIVED"],
      default: "PENDING",
      index: true,
    },
    source: {
      type: String,
      enum: [
        "landing",
        "contact_sales",
        "email_requirements",
        "waitlist",
      ],
      default: "landing",
    },
    notificationStatus: {
      type: String,
      enum: ["SENT", "FAILED", "SKIPPED"],
      default: "SKIPPED",
    },
    notificationMessageId: { type: String, default: null, maxlength: 200 },
    notificationError: { type: String, default: null, maxlength: 2000 },
    ip: { type: String, default: null, maxlength: 64 },
    userAgent: { type: String, default: null, maxlength: 512 },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "quotations",
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

quotationSchema.index({ createdAt: -1 });
quotationSchema.index({ status: 1, createdAt: -1 });

import { registerModel } from "./register";
export const Quotation: Model<QuotationDoc> = registerModel<QuotationDoc>(
  "Quotation",
  quotationSchema,
);
