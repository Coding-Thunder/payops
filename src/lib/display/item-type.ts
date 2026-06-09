/**
 * Item-type display-name resolver.
 *
 * Single source of truth for rendering an ItemType to humans. Every
 * UI surface that needs to show an item-type to a customer or
 * operator MUST go through this function, never read `itemType.key`
 * directly into the DOM.
 *
 * Why this exists: `ItemType.key` is an internal stable identifier
 * (e.g. "engagement", "rental_booking", "milk_carton") used as a
 * foreign-key from Order.lineItems[].itemTypeKey, in analytics
 * grouping, in Mongo indexes. It is grep-able and machine-readable,
 * NOT operator-readable. The display surface is `ItemType.name`
 * (e.g. "Engagement session", "Rental booking", "Milk carton").
 *
 * Historical bug: several UI surfaces (order form line items, items
 * table, analytics "By item type" panel, evidence timeline)
 * rendered `itemTypeKey` directly. Customers saw raw keys like
 * "engagement" leaking through every screen.
 *
 * Fix: all of those callsites now route through this helper, which
 * returns the tenant-curated label OR a neutral "Unknown item type"
 * fallback, but never the raw key.
 */

const UNKNOWN_ITEM_TYPE_LABEL = "Unknown item type";

interface ItemTypeDisplayInput {
  /** Tenant-curated display label. The good case. */
  name?: string | null;
  /** Internal stable identifier. NEVER returned by this helper -
   *  only used as a defensive log signal in dev. */
  key?: string | null;
  /** Some callers (analytics aggregation, denormalised snapshots)
   *  carry the resolved label directly. Accept it for ergonomics. */
  displayName?: string | null;
}

/**
 * Resolve a display label for an ItemType.
 *
 * Precedence:
 *   1. `displayName` if non-empty, caller has already resolved it
 *   2. `name` if non-empty, the canonical tenant-curated label
 *   3. fallback "Unknown item type", refuses to leak `key`
 *
 * The fallback is deliberate: leaking the internal key into the UI
 * is worse than showing an honest unknown, because the key looks
 * like English ("engagement") and the operator never realizes a
 * resolution failure happened.
 */
export function getItemTypeDisplayName(
  input: ItemTypeDisplayInput | null | undefined,
): string {
  if (!input) return UNKNOWN_ITEM_TYPE_LABEL;
  const display = input.displayName?.trim();
  if (display && display.length > 0) return display;
  const name = input.name?.trim();
  if (name && name.length > 0) return name;
  // We INTENTIONALLY do not fall through to `input.key`, that's the
  // bug class this helper exists to prevent.
  return UNKNOWN_ITEM_TYPE_LABEL;
}

export { UNKNOWN_ITEM_TYPE_LABEL };
