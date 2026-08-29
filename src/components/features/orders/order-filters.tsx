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

/** Today's placeholder, kept verbatim for single-service organizations. */
const RENTAL_SEARCH_PLACEHOLDER =
  "Search by order, customer, phone, or vehicle";
/** Used only once the service filter is on screen, where "vehicle" is
 *  no longer the only thing an order can be about. */
const MULTI_SERVICE_SEARCH_PLACEHOLDER = "Search by order, customer, or phone";

interface OrderFiltersProps {
  canSeeAll: boolean;
  /**
   * Service types the viewing organization actually sells. Omit — as every
   * existing caller does — and the service filter is not rendered at all
   * and the search placeholder is unchanged, so the two incumbent brands
   * see exactly the filter bar they see today. The control appears only
   * when there is a genuine choice to make, i.e. more than one type.
   */
  serviceTypes?: ServiceType[];
}

export function OrderFilters({ canSeeAll, serviceTypes }: OrderFiltersProps) {
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

  const serviceOptions = serviceTypes ?? [];
  const showServiceFilter = serviceOptions.length > 1;

// `flex-wrap` rather than a hard md:flex-row: at ~1100px the controls wrap
  // onto a second line gracefully instead of squeezing the search field down
  // to nothing. Trigger heights match the table's h-8 header so the whole
  // view reads at one density.
    return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-1 p-2 md:flex-row md:flex-wrap md:items-center">
      <div className="relative min-w-[180px] flex-1 md:max-w-xs">
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
          placeholder={
            showServiceFilter
              ? MULTI_SERVICE_SEARCH_PLACEHOLDER
              : RENTAL_SEARCH_PLACEHOLDER
          }
          className="h-8 pl-8 bg-background"
        />
      </div>
      {showServiceFilter ? (
        <Select
          value={params.get("serviceType") ?? ALL}
          onValueChange={(v) => update("serviceType", v)}
        >
          <SelectTrigger className="h-8 w-full md:w-[132px]">
            <SelectValue placeholder="Service" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All services</SelectItem>
            {serviceOptions.map((s) => (
              <SelectItem key={s} value={s}>
                {ServiceTypeLabel[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      <Select
        value={params.get("status") ?? ALL}
        onValueChange={(v) => update("status", v)}
      >
        <SelectTrigger className="h-8 w-full md:w-[136px]">
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
        <SelectTrigger className="h-8 w-full md:w-[148px]">
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
      {canSeeAll ? (
        <Select
          value={params.get("mine") === "true" ? "mine" : "all"}
          onValueChange={(v) => update("mine", v === "mine" ? "true" : null)}
        >
          <SelectTrigger className="h-8 w-full md:w-[118px]">
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
