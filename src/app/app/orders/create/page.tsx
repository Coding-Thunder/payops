import { CreateOrderForm } from "@/components/features/orders/create-order-form";
import { CreateFlightOrderForm } from "@/components/features/orders/create-flight-order-form";
import { CreateHotelOrderForm } from "@/components/features/orders/create-hotel-order-form";
import { ServiceTabs } from "@/components/features/orders/service-tabs";
import { PageHeader } from "@/components/common/page-header";
import { CURRENCIES, ServiceType } from "@/lib/constants/enums";
import { Permission } from "@/lib/constants/permissions";
import { requirePermission } from "@/server/auth/session";
import { getSelectedOrganization } from "@/server/auth/organization";
import { Organization } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import { listActiveProviders } from "@/server/services/provider.service";
import { getSettings } from "@/server/services/settings.service";

export const metadata = { title: "Create order" };
export const dynamic = "force-dynamic";

/**
 * Which service types this organization may sell.
 *
 * Same rule as `GET /api/orders/create-config`, resolved here instead of
 * over the wire because this page already has direct server access to
 * everything else the form binds against. Defaults to [CAR_RENTAL] for an
 * organization with no stored list and for a deployment with no
 * organization selected at all.
 */
async function resolveServiceTypes(
  organizationId: string | null,
): Promise<ServiceType[]> {
  if (!organizationId) return [ServiceType.CAR_RENTAL];
  await connectMongo();
  const org = await Organization.findById(organizationId)
    .select("serviceTypes")
    .lean<{ serviceTypes?: ServiceType[] } | null>();
  return org?.serviceTypes && org.serviceTypes.length > 0
    ? org.serviceTypes
    : [ServiceType.CAR_RENTAL];
}

/**
 * Step 1 of the linear flow — booking entry.
 *
 * Server-rendered page that fetches what the form binds against (allowed
 * booking types, default currency, active providers) and renders the form
 * directly. On submit the form posts /api/orders and routes the agent to
 * /orders/[id]/email. No drafts autosave, no workspace shell.
 *
 * SINGLE-SERVICE ORGANIZATIONS RENDER EXACTLY WHAT THEY ALWAYS HAVE. The
 * tab strip is a branch taken only when the organization sells more than
 * one service type; a CAR_RENTAL-only organization — which is both
 * incumbent brands, and any deployment with no organization selected —
 * falls through to `<CreateOrderForm>` at the same position in the same
 * tree, with no wrapper and no `serviceType`-derived filtering applied to
 * its provider list.
 */
export default async function CreateOrderPage() {
  await requirePermission(Permission.ORDER_CREATE);
  const selected = await getSelectedOrganization();
  const organizationId = selected?.id ?? null;
  const serviceTypes = await resolveServiceTypes(organizationId);
  const single = serviceTypes.length === 1 ? serviceTypes[0] : null;

  const [settings, providers] = await Promise.all([
    getSettings(),
    listActiveProviders({
      // Org scoping is backward-compatible: a provider row with an empty
      // `organizationIds` is available to every organization, which is
      // every row that existed before that field — so nothing disappears
      // from the incumbents' dropdown.
      organizationId,
      // A single-service organization only needs that service's suppliers.
      // CAR_RENTAL is deliberately left UNFILTERED so the two incumbent
      // brands get the exact list their form has always shown.
      serviceType:
        single && single !== ServiceType.CAR_RENTAL ? single : undefined,
    }),
  ]);

  const shared = {
    allowedBookingTypes: settings.allowedBookingTypes,
    defaultCurrency: settings.defaultCurrency,
    allowedCurrencies: CURRENCIES,
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Create order"
        description={
          single
            ? "Capture booking details. The payment link is generated when you send the request email."
            : "Pick a service, then capture the booking details. The payment link is generated when you send the request email."
        }
      />
      {single === ServiceType.FLIGHT ? (
        <CreateFlightOrderForm {...shared} providers={providers} />
      ) : single === ServiceType.HOTEL ? (
        <CreateHotelOrderForm {...shared} providers={providers} />
      ) : single ? (
        <CreateOrderForm {...shared} providers={providers} />
      ) : (
        <ServiceTabs
          {...shared}
          serviceTypes={serviceTypes}
          providers={providers}
        />
      )}
    </div>
  );
}
