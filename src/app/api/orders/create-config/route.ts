import { Permission } from "@/lib/constants/permissions";
import { CURRENCIES } from "@/lib/constants/enums";
import { SERVICE_LEGAL_TYPES } from "@/lib/validation";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { getSelectedOrganization } from "@/server/auth/organization";
import { resolveServiceTerms } from "@/server/services/organization-legal.service";
import { resolveOrganizationServiceTypes } from "@/server/services/organization-service-types";
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
 *
 * `legalStatus` (additive): for each FLIGHT / HOTEL service the
 * organization sells, whether its next order would freeze the BUILT-IN
 * terms or cancellation policy — `{ termsIsDefault, policyIsDefault }` —
 * so a form can warn before it happens. Car rental is never listed:
 * inheriting the deployment's car text is the established design.
 */
export const GET = withApi(async () => {
  await requirePermission(Permission.ORDER_CREATE);
  const selected = await getSelectedOrganization();
  const organizationId = selected?.id ?? null;

  // Which service types this organization may sell. Defaults to
  // [CAR_RENTAL] for an organization with no stored list and for a
  // deployment with no organization selected at all — so both incumbent
  // brands get exactly the single-service create page they have today.
  const serviceTypes = await resolveOrganizationServiceTypes(organizationId);

  const [settings, providers, legalStatus] = await Promise.all([
    getSettings(),
    // Scoped to this organization's allowed suppliers. A provider row with
    // an empty `organizationIds` is available to everyone, which is every
    // row that existed before this change — so nothing disappears from the
    // incumbents' dropdown.
    listActiveProviders({ organizationId }),
    // The same rule as the create page, through the resolver order
    // creation freezes with. One read per such service — two at most.
    Promise.all(
      SERVICE_LEGAL_TYPES.filter((t) => serviceTypes.includes(t)).map(
        async (serviceType) => {
          const { termsIsDefault, policyIsDefault } = await resolveServiceTerms({
            organizationId,
            serviceType,
          });
          return [serviceType, { termsIsDefault, policyIsDefault }] as const;
        },
      ),
    ).then(Object.fromEntries),
  ]);

  return jsonOk({
    allowedBookingTypes: settings.allowedBookingTypes,
    defaultCurrency: settings.defaultCurrency,
    allowedCurrencies: CURRENCIES,
    serviceTypes,
    providers,
    legalStatus,
  });
});
