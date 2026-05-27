import { Permission } from "@/lib/constants/permissions";
import { CURRENCIES } from "@/lib/constants/enums";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { getSettings } from "@/server/services/settings.service";
import { listActiveItemTypes } from "@/server/services/item-type.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Lightweight "what does the create-order form need?" endpoint.
 *
 * Gated by ORDER_CREATE so STAFF (who can't read full settings) still get
 * the form defaults. Returns only what the UI binds against — never the
 * full settings document.
 *
 * Pass 5g: the legacy rental `providers` catalog is no longer surfaced
 * here — the dynamic create-order form (Pass 5e) is driven entirely by
 * the org's ItemType catalog. Tenant #1's rental UX still works because
 * the auto-seeded `rental_booking` ItemType carries provider info as a
 * line-item attribute, not as a separate catalog row.
 */
export const GET = withApi(async () => {
  const actor = await requirePermission(Permission.ORDER_CREATE);
  const [settings, itemTypes] = await Promise.all([
    getSettings(actor.orgId),
    listActiveItemTypes(actor.orgId ?? null),
  ]);
  return jsonOk({
    defaultCurrency: settings.defaultCurrency,
    allowedCurrencies: CURRENCIES,
    itemTypes,
  });
});
