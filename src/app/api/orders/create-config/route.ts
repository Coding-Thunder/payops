import { Permission } from "@/lib/constants/permissions";
import { CURRENCIES } from "@/lib/constants/enums";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { getSettings } from "@/server/services/settings.service";
import { listActiveProviders } from "@/server/services/provider.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Lightweight "what does the create-order form need?" endpoint.
 *
 * Gated by ORDER_CREATE so STAFF (who can't read full settings) still get
 * the form defaults. Returns only what the UI binds against — never the
 * full settings document.
 */
export const GET = withApi(async () => {
  await requirePermission(Permission.ORDER_CREATE);
  const [settings, providers] = await Promise.all([
    getSettings(),
    listActiveProviders(),
  ]);
  return jsonOk({
    allowedBookingTypes: settings.allowedBookingTypes,
    defaultCurrency: settings.defaultCurrency,
    allowedCurrencies: CURRENCIES,
    providers,
  });
});
