"use client";

import { useState } from "react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ServiceType } from "@/lib/constants/enums";
import { ServiceTypeLabel } from "@/lib/constants/labels";
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
 * page branches before it, so RentalConfirmation and TripReservations reach
 * `CreateOrderForm` directly with no tab strip, no wrapper element and no
 * extra spacing — exactly the tree they render today.
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

/** Tab order, matching the design: flights first, rental last. Filtered to
 *  what the organization actually sells. */
const TAB_ORDER: readonly ServiceType[] = [
  ServiceType.FLIGHT,
  ServiceType.HOTEL,
  ServiceType.CAR_RENTAL,
];

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
  /** The organization's allowed service types. Rendered in TAB_ORDER. */
  serviceTypes: readonly ServiceType[];
  allowedBookingTypes: readonly BookingType[];
  defaultCurrency: Currency;
  allowedCurrencies: readonly string[];
  /** Org-scoped active provider catalog, narrowed per tab below. */
  providers: ProviderDTO[];
}

export function ServiceTabs({
  serviceTypes,
  allowedBookingTypes,
  defaultCurrency,
  allowedCurrencies,
  providers,
}: ServiceTabsProps) {
  const tabs = TAB_ORDER.filter((t) => serviceTypes.includes(t));
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

      {tabs.includes(ServiceType.FLIGHT) ? (
        <TabsContent {...panelProps(ServiceType.FLIGHT, active)}>
          <CreateFlightOrderForm
            {...shared}
            providers={providersForService(providers, ServiceType.FLIGHT)}
            active={active === ServiceType.FLIGHT}
          />
        </TabsContent>
      ) : null}

      {tabs.includes(ServiceType.HOTEL) ? (
        <TabsContent {...panelProps(ServiceType.HOTEL, active)}>
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
