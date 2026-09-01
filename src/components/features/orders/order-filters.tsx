"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { SearchIcon } from "lucide-react";
import { useState, useTransition } from "react";

import { Input } from "@/components/ui/input";
import { InlineSpinner } from "@/components/ui/spinner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ORDER_STATUSES,
  BOOKING_TYPES,
  type ServiceType,
} from "@/lib/constants/enums";
import {
  BookingTypeLabel,
  OrderStatusLabel,
  ServiceTypeLabel,
} from "@/lib/constants/labels";

const ALL = "__all__";

interface OrderFiltersProps {
  canSeeAll: boolean;
  /**
   * The service types this organization sells. The service filter renders
   * only when there is more than one — on a single-service deployment it
   * would be a dropdown with exactly one meaningful option, which is
   * clutter, and its absence is why a rental-only console's filter bar is
   * unchanged from before service types existed.
   */
  serviceTypes?: readonly ServiceType[];
}

export function OrderFilters({
  canSeeAll,
  serviceTypes = [],
}: OrderFiltersProps) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const currentQueryParam = params.get("q") ?? "";
  const [query, setQuery] = useState(currentQueryParam);
  const [lastSyncedParam, setLastSyncedParam] = useState(currentQueryParam);
  if (currentQueryParam !== lastSyncedParam) {
    setLastSyncedParam(currentQueryParam);
    setQuery(currentQueryParam);
  }

  function update(name: string, value: string | null) {
    const next = new URLSearchParams(params.toString());
    if (value && value !== ALL) next.set(name, value);
    else next.delete(name);
    next.delete("page");
    startTransition(() => router.push(`?${next.toString()}`));
  }

  function commitQuery() {
    update("q", query.trim() || null);
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-1 p-1.5">
      <div className="relative min-w-[180px] flex-1 basis-full sm:basis-auto sm:max-w-sm">
        <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onBlur={commitQuery}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitQuery();
            }
          }}
          placeholder={searchPlaceholder(serviceTypes)}
          className="h-8 pl-8 bg-background"
        />
      </div>
      <Select
        value={params.get("status") ?? ALL}
        onValueChange={(v) => update("status", v)}
      >
        <SelectTrigger className="h-8 w-[140px]">
          <SelectValue placeholder="Status" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All statuses</SelectItem>
          {ORDER_STATUSES.map((s) => (
            <SelectItem key={s} value={s}>
              {OrderStatusLabel[s]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={params.get("bookingType") ?? ALL}
        onValueChange={(v) => update("bookingType", v)}
      >
        <SelectTrigger className="h-8 w-[150px]">
          <SelectValue placeholder="Booking type" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All types</SelectItem>
          {BOOKING_TYPES.map((t) => (
            <SelectItem key={t} value={t}>
              {BookingTypeLabel[t]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {serviceTypes.length > 1 ? (
        <Select
          value={params.get("serviceType") ?? ALL}
          onValueChange={(v) => update("serviceType", v)}
        >
          <SelectTrigger className="h-8 w-[140px]">
            <SelectValue placeholder="Service" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All services</SelectItem>
            {serviceTypes.map((t) => (
              <SelectItem key={t} value={t}>
                {ServiceTypeLabel[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      {canSeeAll ? (
        <Select
          value={params.get("mine") === "true" ? "mine" : "all"}
          onValueChange={(v) => update("mine", v === "mine" ? "true" : null)}
        >
          <SelectTrigger className="h-8 w-[124px]">
            <SelectValue placeholder="Owner" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All staff</SelectItem>
            <SelectItem value="mine">Only mine</SelectItem>
          </SelectContent>
        </Select>
      ) : null}
      {pending ? <InlineSpinner text="Updating" className="px-2" /> : null}
    </div>
  );
}

/**
 * Search-box placeholder, naming what is actually searchable here.
 *
 * The rental-only string is the ORIGINAL copy. Offering "vehicles" as an
 * example on a console that sells flights and cruises would name the one
 * thing the operator cannot search for.
 */
function searchPlaceholder(serviceTypes: readonly ServiceType[]): string {
  if (serviceTypes.length > 1) {
    return "Search orders, customers, bookings";
  }
  switch (serviceTypes[0]) {
    case "FLIGHT":
      return "Search orders, customers, routes";
    case "CRUISE":
      return "Search orders, customers, sailings";
    default:
      return "Search orders, customers, vehicles";
  }
}
