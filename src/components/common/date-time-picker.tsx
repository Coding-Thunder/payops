"use client";

import * as React from "react";
import { format, isValid, parseISO } from "date-fns";
import { CalendarIcon, ClockIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { TimeSegments } from "@/components/common/time-segments";
import { cn } from "@/lib/utils";

interface DateTimePickerProps {
  /** Stored as ISO 8601 string. Empty string = unset. */
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  minDate?: Date;
  maxDate?: Date;
  disabled?: boolean;
  className?: string;
  id?: string;
  ariaInvalid?: boolean;
}

const TRIGGER_FORMAT_DESKTOP = "EEE, d MMM yyyy · HH:mm";
const TRIGGER_FORMAT_MOBILE = "d MMM yy · HH:mm";

/**
 * Compact date + time picker that feels native to the shadcn admin: one
 * trigger button, one popover, segmented time controls. The trigger shows a
 * shorter format on small screens so it doesn't overflow.
 */
export function DateTimePicker({
  value,
  onChange,
  placeholder = "Pick date & time",
  minDate,
  maxDate,
  disabled,
  className,
  id,
  ariaInvalid,
}: DateTimePickerProps) {
  const parsed = React.useMemo(() => {
    if (!value) return null;
    const d = parseISO(value);
    return isValid(d) ? d : null;
  }, [value]);

  const [open, setOpen] = React.useState(false);

  // Local pending state lets users tweak the time before they've picked a date.
  const [pendingHour, setPendingHour] = React.useState<number>(
    parsed ? parsed.getHours() : 10,
  );
  const [pendingMinute, setPendingMinute] = React.useState<number>(
    parsed ? parsed.getMinutes() : 0,
  );
  const [lastSyncedParsed, setLastSyncedParsed] = React.useState(parsed);
  if (parsed !== lastSyncedParsed) {
    setLastSyncedParsed(parsed);
    if (parsed) {
      setPendingHour(parsed.getHours());
      setPendingMinute(parsed.getMinutes());
    }
  }

  function commit(next: Date) {
    onChange(next.toISOString());
  }

  function onSelectDate(date: Date | undefined) {
    if (!date) return;
    const merged = new Date(date);
    merged.setHours(pendingHour, pendingMinute, 0, 0);
    commit(merged);
  }

  function onTimeChange(nextHour: number, nextMinute: number) {
    setPendingHour(nextHour);
    setPendingMinute(nextMinute);
    if (!parsed) return;
    const merged = new Date(parsed);
    merged.setHours(nextHour, nextMinute, 0, 0);
    commit(merged);
  }

  function applyNow() {
    const now = new Date();
    setPendingHour(now.getHours());
    setPendingMinute(now.getMinutes());
    commit(now);
  }

  const longLabel = parsed ? format(parsed, TRIGGER_FORMAT_DESKTOP) : placeholder;
  const shortLabel = parsed ? format(parsed, TRIGGER_FORMAT_MOBILE) : placeholder;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          disabled={disabled}
          aria-invalid={ariaInvalid}
          className={cn(
            "w-full justify-start text-left font-normal tabular-nums",
            !parsed && "text-muted-foreground",
            className,
          )}
        >
          <CalendarIcon className="size-4 text-muted-foreground" />
          <span className="truncate hidden sm:inline">{longLabel}</span>
          <span className="truncate sm:hidden">{shortLabel}</span>
        </Button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-[280px] p-0 overflow-hidden"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <Calendar
          mode="single"
          selected={parsed ?? undefined}
          onSelect={onSelectDate}
          defaultMonth={parsed ?? minDate ?? new Date()}
          disabled={(date) => {
            if (minDate && date < startOfDay(minDate)) return true;
            if (maxDate && date > endOfDay(maxDate)) return true;
            return false;
          }}
        />

        <div className="border-t border-border bg-muted/30 px-3 py-2.5 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-[10.5px] uppercase tracking-wider text-muted-foreground">
              <ClockIcon className="size-3" />
              Time
            </div>
            <button
              type="button"
              onClick={applyNow}
              className="text-[11px] text-primary hover:underline"
            >
              Now
            </button>
          </div>
          <TimeSegments
            hour={pendingHour}
            minute={pendingMinute}
            onChange={onTimeChange}
          />
        </div>

        <div className="flex items-center justify-between border-t border-border px-3 py-2">
          <span className="text-[11px] text-muted-foreground">
            {parsed
              ? format(parsed, "EEE, d MMM · HH:mm")
              : "No date selected"}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-[12px]"
            onClick={() => setOpen(false)}
          >
            Done
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function startOfDay(d: Date): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
}
function endOfDay(d: Date): Date {
  const c = new Date(d);
  c.setHours(23, 59, 59, 999);
  return c;
}
