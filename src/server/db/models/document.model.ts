import {
  Schema,
  type HydratedDocument,
  type Model,
  type Types,
} from "mongoose";

import { registerModel } from "./register";

/**
 * Issued accounting documents (invoices, receipts, future: credit
 * notes / quotes).
 *
 * Append-only. Once a document is issued, it's frozen — re-rendering
 * always uses the stored snapshot, never re-derives from the current
 * Order. That preserves the document's integrity for accounting and
 * audit purposes: an invoice from March 2026 must show the brand /
 * customer details that were correct in March, even if the tenant
 * later renames their workspace or the customer changes their email.
 *
 * Numbering: monotonic per (orgId, kind), allocated atomically via
 * DocumentSequence. Required for tax/accounting compliance in most
 * jurisdictions — sequential, no gaps, no duplicates.
 *
 * MVP storage: HTML snapshot only. PDF is generated on-demand by the
 * browser via a print-stylesheet route ("Save as PDF" from the print
 * dialog). Cheap, no headless-browser dependency, fits the $5 DO
 * footprint. Real PDF blobs land later when a tenant needs to
 * email-attach receipts.
 */

export const DocumentKind = {
  INVOICE: "INVOICE",
  RECEIPT: "RECEIPT",
} as const;
export type DocumentKind = (typeof DocumentKind)[keyof typeof DocumentKind];
export const DOCUMENT_KINDS = Object.values(DocumentKind) as DocumentKind[];

/** Snapshotted at issue time. Renderer reads these — never the live
 *  order/branding rows. */
export interface DocumentSnapshot {
  /** Tenant brand + support details as they were at issue time. */
  brand: {
    name: string;
    supportEmail: string;
    supportPhone: string;
    primaryColor: string;
    logo: string | null;
    /** Legal/postal address from the Organization (when populated). */
    legalName: string | null;
  };
  /** Customer details snapshotted from the Order. */
  customer: {
    name: string;
    email: string;
    phone: string | null;
  };
  /** Line items snapshotted from the Order. */
  lineItems: Array<{
    name: string;
    description: string | null;
    quantity: number;
    unitPrice: number;
    total: number;
  }>;
  /** Money totals. */
  pricing: {
    subtotal: number;
    /** Future: per-line tax breakdown lands in a separate field. */
    taxTotal: number;
    grandTotal: number;
    currency: string;
    /** Amount actually received (RECEIPT only, else null). */
    amountReceived: number | null;
    paidAt: string | null;
  };
  /** Reference back to the order for the operator + customer. */
  order: {
    orderNumber: string;
    createdAt: string;
  };
}

export interface DocumentDoc {
  orgId: Types.ObjectId;
  orderId: Types.ObjectId;
  kind: DocumentKind;
  /** Tenant-facing identifier, e.g. "INV-2026-0001". Unique within
   *  (orgId, kind) — the index below enforces this. */
  number: string;
  issuedAt: Date;
  /** Null for system-issued docs (auto-receipt on payment). */
  issuedByUserId?: Types.ObjectId | null;
  /** Frozen-at-issue snapshot of every field the renderer needs.
   *  Schemaless Mixed because the shape evolves with new doc kinds;
   *  current contract is `DocumentSnapshot`. */
  snapshot: Record<string, unknown>;
  /** Rendered HTML at issue time. Stored so re-renders are
   *  byte-identical and disputes can prove "this is the exact
   *  document we sent to the customer". */
  htmlSnapshot: string;
  createdAt: Date;
  updatedAt: Date;
}

export type DocumentDocument = HydratedDocument<DocumentDoc>;

const documentSchema = new Schema<DocumentDoc>(
  {
    orgId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    orderId: {
      type: Schema.Types.ObjectId,
      ref: "Order",
      required: true,
      index: true,
    },
    kind: { type: String, enum: DOCUMENT_KINDS, required: true },
    number: { type: String, required: true, maxlength: 32 },
    issuedAt: { type: Date, required: true, default: Date.now },
    issuedByUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    snapshot: { type: Schema.Types.Mixed, required: true },
    htmlSnapshot: { type: String, required: true, maxlength: 200_000 },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "documents",
    minimize: false,
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

// One numbering sequence per (orgId, kind). Unique guarantees the
// numbering is gap-free + collision-safe even under concurrent issue
// calls that managed to allocate the same number (the loser retries).
documentSchema.index(
  { orgId: 1, kind: 1, number: 1 },
  { unique: true, name: "documents_orgId_kind_number_unique" },
);
// Per-order listing (Documents tab on order detail page).
documentSchema.index({ orderId: 1, kind: 1, issuedAt: -1 });
// Per-tenant chronological listing (future: an Org-wide Documents page).
documentSchema.index({ orgId: 1, issuedAt: -1 });

// Append-only safety. Once a document is issued, snapshot + html
// must NEVER mutate — the document IS the record. Trying to re-save
// throws so a stray service-layer bug can't silently rewrite history.
documentSchema.pre("findOneAndUpdate", function () {
  throw new Error(
    "Documents are append-only. Issue a new one (e.g. a credit note) instead of editing.",
  );
});
documentSchema.pre("updateOne", function () {
  throw new Error("Documents are append-only.");
});
documentSchema.pre("updateMany", function () {
  throw new Error("Documents are append-only.");
});

export const Document: Model<DocumentDoc> = registerModel<DocumentDoc>(
  "Document",
  documentSchema,
);

/* ──────────────────────── DocumentSequence ──────────────────────────── */

/**
 * Per-tenant per-kind monotonic counter. One doc per (orgId, kind).
 * Atomic `$inc` on findOneAndUpdate gives us a race-safe next-number
 * allocator without a transaction.
 *
 * Format produced by the service (NOT by this collection): a tenant-
 * friendly string like "INV-2026-0001" — see formatDocumentNumber.
 */
export interface DocumentSequenceDoc {
  orgId: Types.ObjectId;
  kind: DocumentKind;
  /** Most recently allocated integer. Service formats it into a
   *  human-friendly number string. */
  lastIssuedSeq: number;
  updatedAt: Date;
}

export type DocumentSequenceDocument = HydratedDocument<DocumentSequenceDoc>;

const documentSequenceSchema = new Schema<DocumentSequenceDoc>(
  {
    orgId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },
    kind: { type: String, enum: DOCUMENT_KINDS, required: true },
    lastIssuedSeq: { type: Number, required: true, default: 0, min: 0 },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "document_sequences",
  },
);

documentSequenceSchema.index(
  { orgId: 1, kind: 1 },
  { unique: true, name: "document_sequences_orgId_kind_unique" },
);

export const DocumentSequence: Model<DocumentSequenceDoc> =
  registerModel<DocumentSequenceDoc>(
    "DocumentSequence",
    documentSequenceSchema,
  );
