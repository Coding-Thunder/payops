import { CreateOrderForm } from "@/components/features/orders/create-order-form";
import { CreateFlightOrderForm } from "@/components/features/orders/create-flight-order-form";
import { CreateHotelOrderForm } from "@/components/features/orders/create-hotel-order-form";
import {
  BuiltInTermsNotice,
  ServiceTabs,
  type ServiceLegalStatusMap,
} from "@/components/features/orders/service-tabs";
import { PageHeader } from "@/components/common/page-header";
import { CURRENCIES, ServiceType } from "@/lib/constants/enums";
import { Permission, roleHasPermission } from "@/lib/constants/permissions";
import { SERVICE_LEGAL_TYPES } from "@/lib/validation";
import { requirePermission } from "@/server/auth/session";
import { getSelectedOrganization } from "@/server/auth/organization";
import { resolveServiceTerms } from "@/server/services/organization-legal.service";
import { resolveOrganizationServiceTypes } from "@/server/services/organization-service-types";
import { listActiveProviders } from "@/server/services/provider.service";
import { getSettings } from "@/server/services/settings.service";

export const metadata = { title: "Create order" };
export const dynamic = "force-dynamic";

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
 *
 * A flight or hotel form says when its order would freeze BUILT-IN terms —
 * the brand has written none of its own for that service — so nobody
 * finds out from a customer's receipt. Non-blocking, and never for car
 * rental, whose inheriting the deployment text is the established design.
 */
export default async function CreateOrderPage() {
  const actor = await requirePermission(Permission.ORDER_CREATE);
  const selected = await getSelectedOrganization();
  const organizationId = selected?.id ?? null;
  // Which service types this organization may sell — the same rule as
  // `GET /api/orders/create-config`, resolved here directly because this
  // page already has server access to everything the form binds against.
  // [CAR_RENTAL] with no stored list or no organization selected.
  const serviceTypes = await resolveOrganizationServiceTypes(organizationId);
  const single = serviceTypes.length === 1 ? serviceTypes[0] : null;

  const [settings, providers, legalStatus] = await Promise.all([
    getSettings(),
    listActiveProviders({
      // Org scoping is backward-compatible: a provider row with an empty
      // `organizationIds` is available to every organization, which is
      // every row that existed before that field — so nothing disappears
      // from the incumbents' dropdown.
      organizationId,
      // A single-service organization only needs that service's suppliers.
      //
      // CAR_RENTAL IS NOW FILTERED TOO, and that is a deliberate change:
      // leaving it unfiltered was safe only while every provider row in the
      // catalog was a car-rental brand. Now that an airline or hotel group
      // CAN be created, an unfiltered list would put them in
      // RentalConfirmation's and TripReservations' dropdowns.
      //
      // This does NOT hide anything from the incumbents. listProviders'
      // CAR_RENTAL branch matches `serviceTypes: CAR_RENTAL` OR a missing
      // key OR an empty array, so every row that existed before the field
      // — i.e. their entire catalog — still matches.
      serviceType: single ?? undefined,
    }),
    // Per sold flight / hotel service: would its next order freeze the
    // built-in terms or policy? The same rule as `GET
    // /api/orders/create-config`, read through `resolveServiceTerms` — the
    // resolver order creation freezes with — so the warning can never
    // disagree with what the order gets. One read per such service (two at
    // most), whatever else the page shows.
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
    ).then((entries): ServiceLegalStatusMap => Object.fromEntries(entries)),
  ]);
  const canEditTerms = roleHasPermission(actor.role, Permission.SETTINGS_UPDATE);

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
        <>
          <BuiltInTermsNotice
            serviceType={ServiceType.FLIGHT}
            status={legalStatus.FLIGHT}
            canEditTerms={canEditTerms}
          />
          <CreateFlightOrderForm {...shared} providers={providers} />
        </>
      ) : single === ServiceType.HOTEL ? (
        <>
          <BuiltInTermsNotice
            serviceType={ServiceType.HOTEL}
            status={legalStatus.HOTEL}
            canEditTerms={canEditTerms}
          />
          <CreateHotelOrderForm {...shared} providers={providers} />
        </>
      ) : single ? (
        <CreateOrderForm {...shared} providers={providers} />
      ) : (
        <ServiceTabs
          {...shared}
          serviceTypes={serviceTypes}
          providers={providers}
          legalStatus={legalStatus}
          canEditTerms={canEditTerms}
        />
      )}
    </div>
  );
}
