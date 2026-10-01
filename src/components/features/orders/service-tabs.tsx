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

/**
 * The create-order surface: one tab per service type, one independently
 * bound form behind each.
 *
 * Adapted from the `main` branch's component of the same name, minus the
 * hotel tab and the per-organization service list — this deployment sells
 * car rentals and flights, from one organization.
 *
 * Two decisions worth stating outright, both inherited from main because
 * both are load-bearing:
 *
 *  1. EACH TAB MOUNTS ITS OWN FORM, and every panel is `forceMount`ed so a
 *     half-filled flight request survives a peek at the rental tab. Radix's
 *     `forceMount` only keeps the panel MOUNTED — it never hides anything —
 *     so the inactive panels are hidden here explicitly, which keeps them
 *     out of the layout, the tab order and the accessibility tree while
 *     their form state lives on.
 *
 *  2. ONLY THE ACTIVE TAB CAN SUBMIT. Each panel contains a separate
 *     `<form>`, so a browser submit is already scoped to one of them; on
 *     top of that the inactive form is handed `active={false}`, which hides
 *     its actions row AND makes its submit handler a no-op. Belt and
 *     braces, because "a hidden tab silently created an order" is not a bug
 *     anyone should have to reproduce.
 *
 * Switching tabs is a Radix value change and nothing else — no form is
 * submitted, reset or re-registered, so neither service's fields can
 * corrupt the other's.
 *
 * On cost: both forms are in the same client bundle and the provider
 * catalog is fetched ONCE on the server and narrowed per tab in memory by
 * `providersForService`, so adding the flight tab costs no extra query and
 * no extra round trip — which is what matters on a small instance.
 */

/** Tab order. Rental first: it is the incumbent flow and the one an
 *  operator lands on by default, so its position does not move. */
const TAB_ORDER: readonly ServiceType[] = [
  ServiceType.CAR_RENTAL,
  ServiceType.FLIGHT,
];

/**
 * Narrow the provider catalog to one service type.
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

/** Force-mounted so form state survives, explicitly hidden when inactive. */
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
  allowedBookingTypes: readonly BookingType[];
  defaultCurrency: Currency;
  allowedCurrencies: readonly string[];
  /** Full active catalog; narrowed per tab below. */
  providers: ProviderDTO[];
}

export function ServiceTabs({
  allowedBookingTypes,
  defaultCurrency,
  allowedCurrencies,
  providers,
}: ServiceTabsProps) {
  const [active, setActive] = useState<ServiceType>(ServiceType.CAR_RENTAL);

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
        {TAB_ORDER.map((t) => (
          <TabsTrigger key={t} value={t} className="px-4">
            {ServiceTypeLabel[t]}
          </TabsTrigger>
        ))}
      </TabsList>

      <TabsContent {...panelProps(ServiceType.CAR_RENTAL, active)}>
        <CreateOrderForm
          {...shared}
          providers={providersForService(providers, ServiceType.CAR_RENTAL)}
        />
      </TabsContent>

      <TabsContent {...panelProps(ServiceType.FLIGHT, active)}>
        <CreateFlightOrderForm
          {...shared}
          providers={providersForService(providers, ServiceType.FLIGHT)}
          active={active === ServiceType.FLIGHT}
        />
      </TabsContent>
    </Tabs>
  );
}
