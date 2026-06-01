import {
  Schema,
  type HydratedDocument,
  type Model,
  type Types,
} from "mongoose";

import {
  CURRENCIES,
  Currency,
  RecordState,
  RECORD_STATES,
} from "@/lib/constants/enums";
import { ITEM_TYPE_KEY_REGEX } from "@/lib/constants/items";

import { registerModel } from "./register";

/**
 * Per-tenant catalog row.
 *
 * A row in this collection is "something this organisation sells."
 * Universal across verticals:
 *
 *   - milk shop:   `{name: "Milk 1L", itemTypeKey: "milk_carton", basePrice: 2}`
 *   - pharmacy:    `{name: "Atorvastatin 20mg", itemTypeKey: "rx_product", basePrice: 0.5, attributes: {sku: "AT-20"}}`
 *   - rental:      `{name: "Toyota Camry", itemTypeKey: "rental_booking", attributes: {vehicleMake: "Toyota", vehicleType: "Camry", imageUrl: "..."}}`
 *   - consulting:  `{name: "Strategy session", itemTypeKey: "consulting_hour", basePrice: 250}`
 *   - subscription:`{name: "Pro plan", itemTypeKey: "subscription_plan", basePrice: 49}`
 *
 * On order creation, the line-item snapshot embeds `name`,
 * `unitPrice`, and the resolved `attributes` so historical orders
 * keep rendering correctly even when the catalog row is later
 * archived or edited.
 *
 * Replaces the legacy `Provider` + `CarLink` collections (which were
 * rental-shaped variants of this primitive). Both will be retired in
 * Pass 5g after Tenant #1 is fully migrated.
 *
 * `attributes` content is validated at the service layer against
 * `ItemType.attributeSchema` for the referenced `itemTypeKey`. The
 * model declares the field as `Mixed` so the schema doesn't have to
 * carry per-tenant shape information.
 *
 * Hard-delete is intentionally absent, historical Orders embed
 * snapshots that we never want to silently break. Use `archive()`
 * (sets `status: ARCHIVED`) instead.
 */

export interface ItemInventorySnapshot {
  available: number;
  reserved: number;
}

export interface ItemPrice {
  /** Major units (e.g. dollars). Mirrors Order.pricing convention. */
  amount: number;
  currency: Currency;
}

export interface ItemDoc {
  orgId: Types.ObjectId;
  /** Reference to the ItemType that defines this Item's attribute
   *  schema + pricing model + email block manifest. Validated at the
   *  service layer (Mongoose doesn't enforce cross-collection refs
   *  in a useful way; we lookup-and-reject on Item create). */
  itemTypeKey: string;
  name: string;
  description?: string | null;
  /** Null when the price is quoted ad-hoc per order (e.g. consulting
   *  engagements, service bookings with variable scope). The line
   *  item's `unitPrice` is then provided at order-create time. */
  basePrice: ItemPrice | null;
  /** Operator-facing inventory key. Optional + nullable; uniqueness
   *  enforced only when present (partial-unique below). */
  sku?: string | null;
  /** Hero image rendered in the create-order picker and in some
   *  email blocks (e.g. ITEM_HERO). Stored as the public path or a
   *  full URL, same convention as `Branding.logo`. */
  imageUrl?: string | null;
  /** Per-tenant per-vertical attribute payload. Validated against the
   *  referenced ItemType.attributeSchema at the service layer. */
  attributes: Record<string, unknown>;
  /** Inventory snapshot, populated only when the referenced
   *  ItemType.inventoryTracked is true. Mutated transactionally by
   *  the inventory module on order PAID / refund. Optional at the
   *  schema level so non-inventory itemTypes don't carry the field. */
  inventory?: ItemInventorySnapshot | null;
  status: RecordState;
  createdBy?: {
    userId: Types.ObjectId;
    name: string;
  } | null;
  updatedBy?: Types.ObjectId | null;
  archivedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ItemDocument = HydratedDocument<ItemDoc>;

const itemPriceSchema = new Schema<ItemPrice>(
  {
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, enum: CURRENCIES, required: true },
  },
  { _id: false },
);

const itemInventorySchema = new Schema<ItemInventorySnapshot>(
  {
    available: { type: Number, required: true, default: 0, min: 0 },
    reserved: { type: Number, required: true, default: 0, min: 0 },
  },
  { _id: false },
);

const itemCreatorSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true, maxlength: 200 },
  },
  { _id: false },
);

const itemSchema = new Schema<ItemDoc>(
  {
    orgId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    itemTypeKey: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 32,
      match: ITEM_TYPE_KEY_REGEX,
    },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, default: null, maxlength: 2000 },
    basePrice: { type: itemPriceSchema, default: null },
    sku: { type: String, default: null, trim: true, maxlength: 64 },
    imageUrl: { type: String, default: null, maxlength: 2048 },
    // `Schema.Types.Mixed`, service-layer validates against the
    // referenced ItemType.attributeSchema. We deliberately don't
    // type-strict here because attribute shapes are per-tenant.
    attributes: { type: Schema.Types.Mixed, default: () => ({}) },
    inventory: { type: itemInventorySchema, default: null },
    status: {
      type: String,
      enum: RECORD_STATES,
      required: true,
      default: RecordState.ACTIVE,
      index: true,
    },
    createdBy: { type: itemCreatorSchema, default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    archivedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "items",
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

// Common admin/picker listing: active items for this org, by type, by name.
itemSchema.index({ orgId: 1, itemTypeKey: 1, status: 1, name: 1 });
// Catalog-search support (regex-on-name path; full-text index lands
// later if/when we add typeahead).
itemSchema.index({ orgId: 1, name: 1 });
// SKU uniqueness when present, operators using SKUs expect them to
// be unique within their tenant. Partial filter so items without
// SKUs (services, consulting, rental units) don't compete on the
// constraint.
itemSchema.index(
  { orgId: 1, sku: 1 },
  {
    unique: true,
    partialFilterExpression: { sku: { $type: "string" } },
    name: "items_orgId_sku_unique",
  },
);

export const Item: Model<ItemDoc> = registerModel<ItemDoc>("Item", itemSchema);
