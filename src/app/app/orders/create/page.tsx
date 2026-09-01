import { CreateOrderForm } from "@/components/features/orders/create-order-form";
import { CreateFlightOrderForm } from "@/components/features/orders/create-flight-order-form";
import { CreateCruiseOrderForm } from "@/components/features/orders/create-cruise-order-form";
import {
  ServiceTabs,
  providersForService,
} from "@/components/features/orders/service-tabs";
import { PageHeader } from "@/components/common/page-header";
import { CURRENCIES, ServiceType } from "@/lib/constants/enums";
import { Permission } from "@/lib/constants/permissions";
import { getOrganization } from "@/server/auth/organization";
import { requirePermission } from "@/server/auth/session";
import { listActiveProviders } from "@/server/services/provider.service";
import { getSettings } from "@/server/services/settings.service";

export const metadata = { title: "Create order" };
export const dynamic = "force-dynamic";

/**
 * Step 1 of the linear flow — booking entry.
 *
 * Server-rendered page that fetches what the forms bind against (allowed
 * booking types, default currency, the active provider catalog) plus what
 * this organization actually sells, then renders one of two shapes:
 *
 *   ONE service   the form directly, with no tab strip — byte-identical to
 *                 what a single-service deployment rendered before service
 *                 types existed.
 *   MANY services `ServiceTabs`, one independently-bound form per tab.
 *
 * The provider catalog is fetched ONCE and narrowed per tab in the client,
 * rather than one query per service: it is a handful of small documents and
 * three round trips to render one page is the kind of N+1 that only looks
 * harmless at three.
 *
 * `serviceTypes` here is presentation. The create route enforces the same
 * list server-side, so a hand-crafted POST cannot create an order shape this
 * brand does not sell.
 */
export default async function CreateOrderPage() {
  await requirePermission(Permission.ORDER_CREATE);
  const [settings, providers, organization] = await Promise.all([
    getSettings(),
    listActiveProviders(),
    getOrganization(),
  ]);

  const shared = {
    allowedBookingTypes: settings.allowedBookingTypes,
    defaultCurrency: settings.defaultCurrency,
    allowedCurrencies: CURRENCIES,
  };

  const serviceTypes = organization.serviceTypes;
  const only = serviceTypes.length === 1 ? serviceTypes[0] : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Create order"
        description={describeServices(serviceTypes)}
      />
      {only === null ? (
        <ServiceTabs
          serviceTypes={serviceTypes}
          {...shared}
          providers={providers}
        />
      ) : only === ServiceType.FLIGHT ? (
        <CreateFlightOrderForm
          {...shared}
          providers={providersForService(providers, ServiceType.FLIGHT)}
        />
      ) : only === ServiceType.CRUISE ? (
        <CreateCruiseOrderForm
          {...shared}
          providers={providersForService(providers, ServiceType.CRUISE)}
        />
      ) : (
        <CreateOrderForm
          {...shared}
          providers={providersForService(providers, ServiceType.CAR_RENTAL)}
        />
      )}
    </div>
  );
}

/**
 * Page subtitle, naming what this brand sells.
 *
 * The single-service car-rental string is the ORIGINAL copy, unchanged, so
 * a rental-only deployment reads exactly as it did before.
 */
function describeServices(serviceTypes: readonly ServiceType[]): string {
  const tail =
    "The payment link is generated when you send the request email.";
  if (
    serviceTypes.length === 1 &&
    serviceTypes[0] === ServiceType.CAR_RENTAL
  ) {
    return `Capture booking details. ${tail}`;
  }
  const nouns: Record<ServiceType, string> = {
    [ServiceType.FLIGHT]: "flight",
    [ServiceType.CRUISE]: "cruise",
    [ServiceType.CAR_RENTAL]: "car rental",
  };
  const list = serviceTypes.map((t) => nouns[t]);
  const joined =
    list.length <= 1
      ? (list[0] ?? "booking")
      : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
  return `Capture ${joined} booking details. ${tail}`;
}
