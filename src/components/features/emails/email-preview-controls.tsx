"use client";

import { useRouter, useSearchParams } from "next/navigation";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BOOKING_TYPES, BookingType } from "@/lib/constants/enums";
import { BookingTypeLabel } from "@/lib/constants/labels";

interface EmailPreviewControlsProps {
  providers: Array<{ key: string; name: string }>;
  activeProvider: string;
  activeBookingType: BookingType;
}

/**
 * Sidebar controls for the admin email-preview page. Each change writes
 * to URL search params; the server component re-renders the iframe.
 */
export function EmailPreviewControls({
  providers,
  activeProvider,
  activeBookingType,
}: EmailPreviewControlsProps) {
  const router = useRouter();
  const params = useSearchParams();

  function update(key: "provider" | "bookingType", value: string) {
    const next = new URLSearchParams(params.toString());
    next.set(key, value);
    router.push(`?${next.toString()}`);
    router.refresh();
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="border-b border-border px-4 py-2.5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Preview data
        </p>
      </div>
      <div className="space-y-3 px-4 py-3">
        <div className="space-y-1.5">
          <label className="text-[11px] font-medium text-muted-foreground">
            Provider
          </label>
          <Select
            value={activeProvider}
            onValueChange={(v) => update("provider", v)}
          >
            <SelectTrigger className="h-9">
              <SelectValue placeholder="Select provider" />
            </SelectTrigger>
            <SelectContent>
              {providers.map((p) => (
                <SelectItem key={p.key} value={p.key}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <label className="text-[11px] font-medium text-muted-foreground">
            Booking type
          </label>
          <Select
            value={activeBookingType}
            onValueChange={(v) => update("bookingType", v)}
          >
            <SelectTrigger className="h-9">
              <SelectValue placeholder="Select booking type" />
            </SelectTrigger>
            <SelectContent>
              {BOOKING_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {BookingTypeLabel[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <p className="pt-1 text-[10.5px] leading-snug text-muted-foreground">
          Customer name, amount, and order number use fixed sample values
          so previews stay consistent across renders.
        </p>
      </div>
    </div>
  );
}
