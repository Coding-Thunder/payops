"use client";

import Link from "next/link";
import { useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SERVICE_TYPES, ServiceType } from "@/lib/constants/enums";
import { ServiceTypeLabel } from "@/lib/constants/labels";
import { serviceNoun } from "@/lib/service-summary";
import { cn } from "@/lib/utils";
import type { BookingType, Currency } from "@/lib/constants/enums";
import type { ProviderDTO } from "@/types";

import { CreateOrderForm } from "./create-order-form";
import { CreateFlightOrderForm } from "./create-flight-order-form";
import { CreateHotelOrderForm } from "./create-hotel-order-form";

/**
 * The multi-service create-order surface: one tab per service type the
 * organization sells, one independently-bound form behind each.
 *
 * THIS COMPONENT IS NEVER RENDERED FOR A SINGLE-SERVICE ORGANIZATION. The
 * page branches before it, so a car-only organization reaches
 * `CreateOrderForm` directly with no tab strip, no wrapper element and no
 * extra spacing — exactly the tree it has always rendered.
 *
 * The tabs come in the order the organization STORES its service types —
 * that array order is the tab order (`OrganizationDoc.serviceTypes`) — and
 * the first is the tab that opens. Each panel keeps its fixed place in the
 * tree whatever that order is, so a form's markup never depends on it.
 *
 * Two decisions worth stating outright:
 *
 *  1. EACH TAB MOUNTS ITS OWN FORM, and every panel is `forceMount`ed so a
 *     half-filled flight request survives a peek at the hotel tab. Radix's
 *     `forceMount` only keeps the panel MOUNTED — it computes
 *     `hidden={!present}` where `present` is `forceMount || isSelected`, so
 *     with force-mounting on it never hides anything. The inactive panels
 *     are therefore hidden here explicitly, which keeps them out of the
 *     layout, the tab order and the accessibility tree while their form
 *     state lives on.
 *
 *  2. ONLY THE ACTIVE TAB CAN SUBMIT. Each panel contains a separate
 *     `<form>` element, so a browser submit is already scoped to one of
 *     them; on top of that the inactive forms are handed `active={false}`,
 *     which both hides their actions row and makes their submit handler a
 *     no-op. Belt and braces, because "a hidden tab silently created an
 *     order" is not a bug anyone should have to reproduce.
 *
 * Switching tabs is a Radix value change and nothing else — no form is
 * submitted, reset, or re-registered, so no service's fields can corrupt
 * another's.
 */

/**
 * The tabs: the organization's service types in the order it stores them.
 * A type stored twice is listed once, and anything that is not a service
 * type is dropped.
 */
function tabsInStoredOrder(serviceTypes: readonly ServiceType[]): ServiceType[] {
  return serviceTypes.filter(
    (t, i) => SERVICE_TYPES.includes(t) && serviceTypes.indexOf(t) === i,
  );
}

/**
 * Whether a service's next order would freeze the BUILT-IN text — the
 * brand has written no terms (or no cancellation policy) of its own for it.
 * The flags `resolveServiceTerms` returns, as the create page and
 * `GET /api/orders/create-config` pass them on.
 */
export interface ServiceLegalStatus {
  termsIsDefault: boolean;
  policyIsDefault: boolean;
}

/** One entry per sold FLIGHT / HOTEL service. Never car rental: inheriting
 *  the deployment's car text is the established design. */
export type ServiceLegalStatusMap = Partial<Record<ServiceType, ServiceLegalStatus>>;

/** Where a brand writes its own terms. */
const LEGAL_SETTINGS_HREF = "/app/admin/settings";

/**
 * Says, before an order is created, that it would freeze BUILT-IN terms:
 * the brand has no flight (or hotel) terms or cancellation policy of its
 * own, so each new order of that service freezes the built-in,
 * brand-neutral text until it writes its own. Non-blocking: the form works
 * either way. Points an agent who can edit settings there; anyone else is
 * told to ask an admin rather than handed a link they cannot open.
 * Renders nothing once the brand has its own text.
 */
export function BuiltInTermsNotice({
  serviceType,
  status,
  canEditTerms = false,
  className,
}: {
  serviceType: ServiceType;
  status: ServiceLegalStatus | null | undefined;
  canEditTerms?: boolean;
  className?: string;
}) {
  if (!status || (!status.termsIsDefault && !status.policyIsDefault)) {
    return null;
  }
  const noun = serviceNoun({ serviceType });
  const both = status.termsIsDefault && status.policyIsDefault;
  const missing = both
    ? "terms or cancellation policy"
    : status.termsIsDefault
      ? "terms"
      : "cancellation policy";
  const frozen = both ? "terms and cancellation policy" : missing;
  return (
    <Alert variant="warning" className={className}>
      <AlertTitle>{`Built-in ${noun} ${frozen} in use`}</AlertTitle>
      <AlertDescription>
        {`This brand has no ${noun} ${missing} of its own yet. New ${noun} orders will freeze the built-in ${noun} ${frozen}. `}
        {canEditTerms ? (
          <>
            {"Add the brand's own in "}
            <Link
              href={LEGAL_SETTINGS_HREF}
              className="font-medium underline underline-offset-2"
            >
              Admin → Settings
            </Link>
            .
          </>
        ) : (
          "Ask an admin to add the brand's own in Admin → Settings."
        )}
      </AlertDescription>
    </Alert>
  );
}

/**
 * Narrow the org-scoped provider catalog to one service type.
 *
 * A row with no `serviceTypes` predates the field and is a car-rental
 * supplier — the same rule the server-side filter uses — so legacy rows
 * keep showing up on the rental tab and nowhere else.
 */
export function providersForService(
  providers: ProviderDTO[],
  serviceType: ServiceType,
): ProviderDTO[] {
  return providers.filter((p) => {
    const types =
      p.serviceTypes && p.serviceTypes.length > 0
        ? p.serviceTypes
        : [ServiceType.CAR_RENTAL];
    return types.includes(serviceType);
  });
}

/**
 * Panel props for one tab: force-mounted so its form state survives, and
 * explicitly hidden when it is not the active tab (see the note above —
 * `forceMount` alone would leave every panel visible at once). Both the
 * `hidden` attribute and the utility class are applied: the attribute is
 * what assistive tech and the tab order read, the class is what guarantees
 * `display: none` regardless of cascade.
 */
function panelProps(serviceType: ServiceType, active: ServiceType) {
  const isActive = serviceType === active;
  return {
    forceMount: true as const,
    value: serviceType,
    hidden: !isActive,
    className: cn("mt-0", !isActive && "hidden"),
  };
}

interface ServiceTabsProps {
  /** The organization's allowed service types, in its stored order — the
   *  tab order; the first one opens. */
  serviceTypes: readonly ServiceType[];
  allowedBookingTypes: readonly BookingType[];
  defaultCurrency: Currency;
  allowedCurrencies: readonly string[];
  /** Org-scoped active provider catalog, narrowed per tab below. */
  providers: ProviderDTO[];
  /** Per sold flight / hotel service: would its next order freeze built-in
   *  terms? Each such tab says so. Omitted: no notices. */
  legalStatus?: ServiceLegalStatusMap;
  /** Whether the viewer may edit the brand's terms (Admin → Settings). */
  canEditTerms?: boolean;
}

export function ServiceTabs({
  serviceTypes,
  allowedBookingTypes,
  defaultCurrency,
  allowedCurrencies,
  providers,
  legalStatus,
  canEditTerms = false,
}: ServiceTabsProps) {
  const tabs = tabsInStoredOrder(serviceTypes);
  const [active, setActive] = useState<ServiceType>(
    tabs[0] ?? ServiceType.CAR_RENTAL,
  );

  const shared = {
    allowedBookingTypes,
    defaultCurrency,
    allowedCurrencies,
  };

  return (
    <Tabs
      value={active}
      onValueChange={(v) => setActive(v as ServiceType)}
      className="space-y-6"
    >
      <TabsList>
        {tabs.map((t) => (
          <TabsTrigger key={t} value={t} className="px-4">
            {ServiceTypeLabel[t]}
          </TabsTrigger>
        ))}
      </TabsList>

      {/* Fixed panel slots — flight, hotel, car — whatever the tab order:
          a panel's place in the tree never moves, so neither do the ids its
          form generates. Car rental never carries a terms notice. */}
      {tabs.includes(ServiceType.FLIGHT) ? (
        <TabsContent {...panelProps(ServiceType.FLIGHT, active)}>
          <BuiltInTermsNotice
            serviceType={ServiceType.FLIGHT}
            status={legalStatus?.FLIGHT}
            canEditTerms={canEditTerms}
            className="mb-6"
          />
          <CreateFlightOrderForm
            {...shared}
            providers={providersForService(providers, ServiceType.FLIGHT)}
            active={active === ServiceType.FLIGHT}
          />
        </TabsContent>
      ) : null}

      {tabs.includes(ServiceType.HOTEL) ? (
        <TabsContent {...panelProps(ServiceType.HOTEL, active)}>
          <BuiltInTermsNotice
            serviceType={ServiceType.HOTEL}
            status={legalStatus?.HOTEL}
            canEditTerms={canEditTerms}
            className="mb-6"
          />
          <CreateHotelOrderForm
            {...shared}
            providers={providersForService(providers, ServiceType.HOTEL)}
            active={active === ServiceType.HOTEL}
          />
        </TabsContent>
      ) : null}

      {tabs.includes(ServiceType.CAR_RENTAL) ? (
        <TabsContent {...panelProps(ServiceType.CAR_RENTAL, active)}>
          <CreateOrderForm
            {...shared}
            providers={providersForService(providers, ServiceType.CAR_RENTAL)}
            active={active === ServiceType.CAR_RENTAL}
          />
        </TabsContent>
      ) : null}
    </Tabs>
  );
}
