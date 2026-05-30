import { Permission } from "@/lib/constants/permissions";
import { CURRENCIES } from "@/lib/constants/enums";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { getSettings } from "@/server/services/settings.service";
import { listActiveItemTypes } from "@/server/services/item-type.service";
import { listActiveItems } from "@/server/services/item.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "What does the create-order form need?" endpoint.
 *
 * Gated by ORDER_CREATE so STAFF (who can't read full settings) still
 * get the form defaults. Returns only what the UI binds against —
 * never the full settings document.
 *
 * Pass 6c: also surfaces the per-org active Item catalog so the
 * dynamic form can offer "Pick from catalog" alongside the existing
 * "Add line by item type" path.
 */
export const GET = withApi(async () => {
  const actor = await requirePermission(Permission.ORDER_CREATE);
  const [settings, itemTypes, items] = await Promise.all([
    getSettings(actor.orgId),
    listActiveItemTypes(actor.orgId ?? null),
    // Catalog is optional — `actor.orgId` is null for legacy callers,
    // in which case `listActiveItems` would throw. Skip silently.
    actor.orgId ? listActiveItems(actor.orgId) : Promise.resolve([]),
  ]);
  return jsonOk({
    defaultCurrency: settings.defaultCurrency,
    allowedCurrencies: CURRENCIES,
    itemTypes,
    items,
  });
});
