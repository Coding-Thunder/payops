/**
 * Universal commerce primitives — pricing models, attribute types,
 * scheduling shapes, and the finite library of composable email blocks
 * that ItemTypes can opt their orders into.
 *
 * Phase 5 architectural verdict: PayOps becomes a vertical-agnostic
 * commerce + payment-ops platform. The Order schema carries
 * `lineItems[].itemTypeKey` + `attributes`; the SHAPE of those
 * attributes is per-tenant per-vertical, defined in an `ItemType`
 * collection. The values below are the platform-controlled
 * vocabulary that ItemType definitions must pick from — i.e. the
 * non-configurable surface.
 *
 * Discipline:
 *   - Adding a new enum value is a platform decision (code change).
 *   - Tenants pick from these enums when defining their ItemType.
 *   - Tenants CANNOT define new values — keeps the email block
 *     library finite (a real risk if tenants could mint their own).
 */

/* ─────────────────────────── Pricing model ───────────────────────────── */

/**
 * How the line-item's total is computed. Defines what UI controls
 * the create-order form renders (quantity stepper vs interval picker
 * vs date-range picker).
 *
 *   FIXED        — one-shot price; quantity always 1 (e.g. service call).
 *   QUANTITY     — unit price × quantity; cart-style. Default for retail.
 *   INTERVAL     — recurring billing per interval (subscription module).
 *   TIME_WINDOW  — price scoped to a start/end window (rental, hotel).
 *
 * Per-order Total = sum of line totals. Computation rule lives in the
 * service, not configurable. Tax module adds tax line(s) on top.
 */
export const ItemPricingModel = {
  FIXED: "FIXED",
  QUANTITY: "QUANTITY",
  INTERVAL: "INTERVAL",
  TIME_WINDOW: "TIME_WINDOW",
} as const;
export type ItemPricingModel =
  (typeof ItemPricingModel)[keyof typeof ItemPricingModel];
export const ITEM_PRICING_MODELS = Object.values(
  ItemPricingModel,
) as ItemPricingModel[];

/* ───────────────────────── Attribute primitives ──────────────────────── */

/**
 * The finite set of attribute types ItemType.attributeSchema can use.
 * Drives both server-side validation and dynamic form rendering on
 * the frontend.
 *
 *   STRING   — single line of text. Default control.
 *   NUMBER   — numeric input. Integer or float per `precision` field.
 *   DATE     — ISO date / datetime. Drives the calendar picker.
 *   URL      — must parse as http(s); useful for image refs etc.
 *   SELECT   — closed enum. `options[]` must be supplied.
 *   BOOLEAN  — checkbox / toggle.
 *
 * NB: no "file upload" type here — file uploads go through their own
 * routes (logo, evidence) and are referenced as URL strings in
 * attributes. Keeps the model layer storage-shape free.
 */
export const ItemAttributeType = {
  STRING: "STRING",
  NUMBER: "NUMBER",
  DATE: "DATE",
  URL: "URL",
  SELECT: "SELECT",
  BOOLEAN: "BOOLEAN",
} as const;
export type ItemAttributeType =
  (typeof ItemAttributeType)[keyof typeof ItemAttributeType];
export const ITEM_ATTRIBUTE_TYPES = Object.values(
  ItemAttributeType,
) as ItemAttributeType[];

/** Attribute keys must be `[a-z][a-z0-9_]{0,31}` — lowercase, snake-case,
 *  matches the convention used by Mongo dotted paths so denormalised
 *  search-key fields can be added without name collisions. */
export const ITEM_ATTRIBUTE_KEY_REGEX = /^[a-z][a-z0-9_]{0,31}$/;

/* ───────────────────────────── Scheduling ────────────────────────────── */

/**
 * Shape of the time window an order (or line item) lives in. Only
 * present when at least one line's ItemType has `requiresScheduling`.
 *
 *   FIXED_WINDOW       — startsAt + endsAt, both required, immutable
 *                        once paid (rental, hotel, fixed appointment).
 *   OPEN_ENDED         — startsAt required, endsAt nullable (consulting
 *                        engagement that ends on signoff).
 *   RECURRING_INTERVAL — startsAt + endsAt define the first cycle; the
 *                        subscription module mints new cycles on rollover.
 */
export const SchedulingType = {
  FIXED_WINDOW: "FIXED_WINDOW",
  OPEN_ENDED: "OPEN_ENDED",
  RECURRING_INTERVAL: "RECURRING_INTERVAL",
} as const;
export type SchedulingType = (typeof SchedulingType)[keyof typeof SchedulingType];
export const SCHEDULING_TYPES = Object.values(
  SchedulingType,
) as SchedulingType[];

/* ─────────────────────── Composable email blocks ─────────────────────── */

/**
 * The CODE-CONTROLLED library of email blocks. ItemType.confirmationEmailBlocks
 * declares which of these to render on payment-confirmation +
 * payment-request emails for orders containing the item type.
 *
 * Tenants pick from this set; they CANNOT introduce new block kinds
 * (that would let a tenant inject arbitrary email markup). The
 * server-side renderer maps each key to a React Email component.
 *
 * Keep this list short and meaningful. Adding a new block is a
 * deliberate platform decision (code + visual review) — not config.
 */
export const EmailBlockKey = {
  /** Total paid / due, transaction ref, paid-on date. Universal. */
  PAYMENT_SUMMARY: "payment_summary",
  /** Tabular rendering of all line items: name × qty × unit × total. */
  LINE_ITEMS_TABLE: "line_items_table",
  /** Order-level totals: subtotal, tax, discount, grand total. */
  TOTALS: "totals",
  /** Pickup / dropoff or appointment window — only when the order has
   *  `scheduling`. Renders date + time + (optional) location text. */
  SCHEDULING_WINDOW: "scheduling_window",
  /** Hero image + headline for a single visual item (legacy rental
   *  "vehicle hero" generalised). Driven by an attribute of type URL. */
  ITEM_HERO: "item_hero",
  /** Rx number + refills line — pharmacy-friendly without baking
   *  pharmacy assumptions into the platform. */
  PRESCRIPTION_BLOCK: "prescription_block",
  /** Cancellation / refund / terms-of-purchase snapshot. Universal. */
  PURCHASE_TERMS: "purchase_terms",
  /** Support email + phone + brand-tagline footer. Universal. */
  SUPPORT_SECTION: "support_section",
  /** Customer signature acknowledgement (consent-received emails). */
  SIGNATURE_BLOCK: "signature_block",
  /** Tracking number / fulfilment ETA — for verticals that ship goods. */
  TRACKING_INFO: "tracking_info",
  /** Refund issued (amount, reason) block — used in refund emails. */
  REFUND_DETAILS: "refund_details",
} as const;
export type EmailBlockKey = (typeof EmailBlockKey)[keyof typeof EmailBlockKey];
export const EMAIL_BLOCK_KEYS = Object.values(EmailBlockKey) as EmailBlockKey[];

/**
 * Universal blocks that EVERY confirmation email gets, regardless of
 * what the ItemType declares. The ItemType extends this baseline by
 * adding kind-specific blocks (e.g. scheduling_window for rental,
 * prescription_block for pharmacy).
 */
export const DEFAULT_CONFIRMATION_BLOCKS: EmailBlockKey[] = [
  EmailBlockKey.PAYMENT_SUMMARY,
  EmailBlockKey.LINE_ITEMS_TABLE,
  EmailBlockKey.TOTALS,
  EmailBlockKey.PURCHASE_TERMS,
  EmailBlockKey.SUPPORT_SECTION,
];

/* ─────────────────────── ItemType key validation ─────────────────────── */

/** ItemType.key shape — same vocabulary as attribute keys. Tenants
 *  pick short identifiers like `milk_carton`, `service_visit`,
 *  `rental_booking`, `consulting_hour`. */
export const ITEM_TYPE_KEY_REGEX = /^[a-z][a-z0-9_]{0,31}$/;
