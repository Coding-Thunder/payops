import { Permission } from "@/lib/constants/permissions";
import { CURRENCIES, ServiceType } from "@/lib/constants/enums";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { getSelectedOrganization } from "@/server/auth/organization";
import { Organization } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
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
  const selected = await getSelectedOrganization();

  // Which service types this organization may sell. Defaults to
  // [CAR_RENTAL] for an organization with no stored list and for a
  // deployment with no organization selected at all — so both incumbent
  // brands get exactly the single-service create page they have today.
  let serviceTypes: ServiceType[] = [ServiceType.CAR_RENTAL];
  if (selected) {
    await connectMongo();
    const org = await Organization.findById(selected.id)
      .select("serviceTypes")
      .lean<{ serviceTypes?: ServiceType[] } | null>();
    if (org?.serviceTypes && org.serviceTypes.length > 0) {
      serviceTypes = org.serviceTypes;
    }
  }

  const [settings, providers] = await Promise.all([
    getSettings(),
    // Scoped to this organization's allowed suppliers. A provider row with
    // an empty `organizationIds` is available to everyone, which is every
    // row that existed before this change — so nothing disappears from the
    // incumbents' dropdown.
    listActiveProviders({ organizationId: selected?.id ?? null }),
  ]);

  return jsonOk({
    allowedBookingTypes: settings.allowedBookingTypes,
    defaultCurrency: settings.defaultCurrency,
    allowedCurrencies: CURRENCIES,
    serviceTypes,
    providers,
  });
});
