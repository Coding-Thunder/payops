import {
  Schema,
  type HydratedDocument,
  type Model,
  type Types,
} from "mongoose";

import { RecordState, RECORD_STATES } from "@/lib/constants/enums";
import {
  EmailBlockKey,
  EMAIL_BLOCK_KEYS,
  ItemAttributeType,
  ItemPricingModel,
  ITEM_ATTRIBUTE_KEY_REGEX,
  ITEM_ATTRIBUTE_TYPES,
  ITEM_PRICING_MODELS,
  ITEM_TYPE_KEY_REGEX,
  DEFAULT_CONFIRMATION_BLOCKS,
} from "@/lib/constants/items";

import { registerModel } from "./register";

/**
 * Per-tenant vertical schema definition.
 *
 * An `ItemType` row describes the SHAPE of a class of orderable thing
 * for one organisation:
 *
 *   - "milk_carton"      — a Pricing-Model=QUANTITY, no scheduling, no
 *                          attributes beyond the default name/price.
 *   - "service_visit"    — FIXED price, optional scheduling, no inventory.
 *   - "rental_booking"   — TIME_WINDOW price, REQUIRES scheduling,
 *                          attributes [vehicleMake, vehicleType, imageUrl,
 *                          providerKey].
 *   - "consulting_hour"  — QUANTITY price (per hour), no scheduling.
 *   - "subscription_plan"— INTERVAL price, requires scheduling
 *                          (renewal cycles).
 *
 * The schema is per-org so two tenants in the same vertical can
 * customise independently (a dealership might want `vin` while
 * another doesn't). Platform ships no built-in ItemType rows —
 * the migration script seeds Tenant #1's "rental_booking" type
 * from their existing rental data; new tenants define their own.
 *
 * `attributeSchema` is the discoverability primitive: dynamic
 * create-order forms read it to render fields, the server validates
 * line-item attributes against it, and confirmation emails know
 * which attributes to surface based on `confirmationEmailBlocks`.
 *
 * Hard constraints (NOT configurable):
 *   - Order lifecycle states (NOT_INITIATED → ... → PAID/FAILED)
 *   - Webhook idempotency, evidence chain, consent flow
 *   - Email block library (this collection picks blocks FROM the
 *     finite list; tenants cannot mint new block kinds)
 */

/** Single attribute spec inside `ItemType.attributeSchema[]`. */
export interface ItemAttributeSpec {
  /** Lowercase snake_case identifier — used as the key on
   *  `OrderLineItem.attributes`, in Mongo dotted paths, and as a
   *  React key in dynamic forms. */
  key: string;
  /** Display label rendered next to the form input. */
  label: string;
  type: ItemAttributeType;
  required: boolean;
  /** Options for `type === SELECT`. Ignored otherwise. */
  options?: string[];
  /** Inline help text rendered under the input. */
  helpText?: string;
  /** Render order in the dynamic form. Ties broken by `key`. */
  displayOrder: number;
}

export interface ItemTypeDoc {
  orgId: Types.ObjectId;
  /** Stable identifier persisted on every Order.lineItem snapshot.
   *  Renaming would break historical orders; we intentionally do not
   *  expose a rename mutation. */
  key: string;
  name: string;
  description?: string | null;
  pricingModel: ItemPricingModel;
  requiresScheduling: boolean;
  inventoryTracked: boolean;
  attributeSchema: ItemAttributeSpec[];
  /** Subset of the finite EmailBlockKey vocabulary — server-side
   *  email render iterates over (defaults + these) and skips any
   *  block whose data isn't present. */
  confirmationEmailBlocks: EmailBlockKey[];
  status: RecordState;
  createdBy?: Types.ObjectId | null;
  updatedBy?: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ItemTypeDocument = HydratedDocument<ItemTypeDoc>;

const attributeSpecSchema = new Schema<ItemAttributeSpec>(
  {
    key: {
      type: String,
      required: true,
      trim: true,
      maxlength: 32,
      match: ITEM_ATTRIBUTE_KEY_REGEX,
    },
    label: { type: String, required: true, trim: true, maxlength: 120 },
    type: { type: String, enum: ITEM_ATTRIBUTE_TYPES, required: true },
    required: { type: Boolean, required: true, default: false },
    options: { type: [String], default: undefined },
    helpText: { type: String, default: null, maxlength: 280 },
    displayOrder: { type: Number, required: true, default: 0 },
  },
  { _id: false },
);

const itemTypeSchema = new Schema<ItemTypeDoc>(
  {
    orgId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    key: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 32,
      match: ITEM_TYPE_KEY_REGEX,
    },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, default: null, maxlength: 500 },
    pricingModel: {
      type: String,
      enum: ITEM_PRICING_MODELS,
      required: true,
    },
    requiresScheduling: { type: Boolean, required: true, default: false },
    inventoryTracked: { type: Boolean, required: true, default: false },
    attributeSchema: { type: [attributeSpecSchema], default: () => [] },
    confirmationEmailBlocks: {
      type: [String],
      enum: EMAIL_BLOCK_KEYS,
      default: () => [...DEFAULT_CONFIRMATION_BLOCKS],
    },
    status: {
      type: String,
      enum: RECORD_STATES,
      required: true,
      default: RecordState.ACTIVE,
      index: true,
    },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "item_types",
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

/* ────────────────────────────── Indexes ──────────────────────────────── */

// One ItemType per (orgId, key). Tenants can have many types; the key
// is the stable persisted identifier on Order line snapshots.
itemTypeSchema.index(
  { orgId: 1, key: 1 },
  { unique: true, name: "item_types_orgId_key_unique" },
);
// Common admin/list query: active types for this org, sorted by name.
itemTypeSchema.index({ orgId: 1, status: 1, name: 1 });

/**
 * Pre-validate: every attribute spec must have a unique `key` within
 * the same itemType. Mongo doesn't enforce uniqueness inside an
 * array, so this catches operator typos at write time rather than at
 * order-creation time when validation against the schema would silently
 * collapse two identical-key attributes.
 */
itemTypeSchema.pre("validate", function () {
  const seen = new Set<string>();
  for (const spec of this.attributeSchema ?? []) {
    if (seen.has(spec.key)) {
      throw new Error(
        `ItemType "${this.key}" has duplicate attribute key "${spec.key}".`,
      );
    }
    seen.add(spec.key);
    if (spec.type === ItemAttributeType.SELECT) {
      if (!spec.options || spec.options.length === 0) {
        throw new Error(
          `ItemType "${this.key}" attribute "${spec.key}" is SELECT but has no options.`,
        );
      }
    }
  }
});

export const ItemType: Model<ItemTypeDoc> = registerModel<ItemTypeDoc>(
  "ItemType",
  itemTypeSchema,
);
