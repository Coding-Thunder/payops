"use client";

import * as React from "react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

interface TimeSegmentsProps {
  hour: number;
  minute: number;
  onChange: (hour: number, minute: number) => void;
  /** Snap minutes in the dropdown to this step. The current value is always
   *  included even if it doesn't align to the step. */
  minuteStep?: number;
  /** Quick-pick presets shown as inline chips ("09:00", "12:00", etc.). */
  presets?: ReadonlyArray<{ label: string; hour: number; minute: number }>;
  className?: string;
}

const DEFAULT_PRESETS = [
  { label: "09:00", hour: 9, minute: 0 },
  { label: "12:00", hour: 12, minute: 0 },
  { label: "15:00", hour: 15, minute: 0 },
  { label: "18:00", hour: 18, minute: 0 },
] as const;

const HOURS = Array.from({ length: 24 }, (_, i) => i);

const pad = (n: number) => n.toString().padStart(2, "0");

/**
 * Compact segmented time picker:
 *   [ hh ▾ ] : [ mm ▾ ]   inline preset chips on the right
 *
 * Replaces the older scroll-wheel UI - feels native to the rest of the
 * shadcn admin and stays inside ~248px wide.
 */
export function TimeSegments({
  hour,
  minute,
  onChange,
  minuteStep = 5,
  presets = DEFAULT_PRESETS,
  className,
}: TimeSegmentsProps) {
  const minuteOptions = React.useMemo(() => {
    const set = new Set<number>();
    for (let m = 0; m < 60; m += minuteStep) set.add(m);
    set.add(minute);
    return Array.from(set).sort((a, b) => a - b);
  }, [minute, minuteStep]);

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-center gap-1.5">
        <Select
          value={String(hour)}
          onValueChange={(v) => onChange(Number(v), minute)}
        >
          <SelectTrigger className="h-8 w-16 px-2 text-[13px] tabular-nums">
            <SelectValue placeholder="hh" />
          </SelectTrigger>
          <SelectContent className="max-h-60">
            {HOURS.map((h) => (
              <SelectItem
                key={h}
                value={String(h)}
                className="text-[13px] tabular-nums"
              >
                {pad(h)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-muted-foreground text-sm font-medium select-none">
          :
        </span>
        <Select
          value={String(minute)}
          onValueChange={(v) => onChange(hour, Number(v))}
        >
          <SelectTrigger className="h-8 w-16 px-2 text-[13px] tabular-nums">
            <SelectValue placeholder="mm" />
          </SelectTrigger>
          <SelectContent className="max-h-60">
            {minuteOptions.map((m) => (
              <SelectItem
                key={m}
                value={String(m)}
                className="text-[13px] tabular-nums"
              >
                {pad(m)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-wrap gap-1">
        {presets.map((p) => {
          const isActive = p.hour === hour && p.minute === minute;
          return (
            <button
              key={p.label}
              type="button"
              onClick={() => onChange(p.hour, p.minute)}
              className={cn(
                "rounded-full border px-2 py-0.5 text-[11px] tabular-nums transition-colors",
                isActive
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {p.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
