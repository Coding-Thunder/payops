"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { SearchIcon } from "lucide-react";
import { useEffect, useState, useTransition } from "react";

import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ORDER_STATUSES, BOOKING_TYPES } from "@/lib/constants/enums";
import {
  BookingTypeLabel,
  OrderStatusLabel,
} from "@/lib/constants/labels";

const ALL = "__all__";

interface OrderFiltersProps {
  canSeeAll: boolean;
}

export function OrderFilters({ canSeeAll }: OrderFiltersProps) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [query, setQuery] = useState(params.get("q") ?? "");

  useEffect(() => {
    setQuery(params.get("q") ?? "");
  }, [params]);

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
    <div className="flex flex-col gap-3 md:flex-row md:items-center">
      <div className="relative flex-1 max-w-md">
        <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
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
          placeholder="Search by order, customer, phone, or vehicle"
          className="pl-9"
        />
      </div>
      <Select
        value={params.get("status") ?? ALL}
        onValueChange={(v) => update("status", v)}
      >
        <SelectTrigger className="w-full md:w-48">
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
        <SelectTrigger className="w-full md:w-52">
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
          <SelectTrigger className="w-full md:w-40">
            <SelectValue placeholder="Owner" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All staff</SelectItem>
            <SelectItem value="mine">Only mine</SelectItem>
          </SelectContent>
        </Select>
      ) : null}
      {pending ? (
        <span className="text-xs text-muted-foreground">Updating…</span>
      ) : null}
    </div>
  );
}
