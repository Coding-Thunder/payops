"use client";

import * as React from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { DayPicker } from "react-day-picker";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type CalendarProps = React.ComponentProps<typeof DayPicker>;

/**
 * Minimal calendar built on react-day-picker. Tightly sized to feel like an
 * inline UI element rather than a free-standing widget - cells are 32px,
 * header is compact, and the overall footprint is ~256px wide.
 */
function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  ...props
}: CalendarProps) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn("p-3", className)}
      classNames={{
        months: "flex flex-col gap-3",
        month: "flex flex-col gap-2",
        month_caption:
          "flex items-center justify-center relative h-8 mb-0.5",
        caption_label: "text-[13px] font-medium tracking-tight",
        nav: "flex items-center gap-1",
        button_previous: cn(
          buttonVariants({ variant: "ghost", size: "icon-sm" }),
          "absolute left-0 top-0 size-7 bg-transparent p-0 text-muted-foreground opacity-80 hover:opacity-100 hover:bg-muted",
        ),
        button_next: cn(
          buttonVariants({ variant: "ghost", size: "icon-sm" }),
          "absolute right-0 top-0 size-7 bg-transparent p-0 text-muted-foreground opacity-80 hover:opacity-100 hover:bg-muted",
        ),
        month_grid: "w-full border-collapse",
        weekdays: "flex",
        weekday:
          "text-muted-foreground/80 w-8 text-center font-medium text-[10.5px] uppercase tracking-wider pb-1",
        week: "flex w-full",
        day: "relative h-8 w-8 p-0 text-center text-[12.5px] focus-within:relative focus-within:z-20",
        day_button: cn(
          "size-8 p-0 font-normal text-foreground rounded-md transition-colors",
          "hover:bg-muted hover:text-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
          "aria-selected:bg-primary aria-selected:text-primary-foreground aria-selected:font-medium",
          "disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed",
        ),
        selected: "",
        today:
          "[&:not(.rdp-selected)>button]:ring-1 [&:not(.rdp-selected)>button]:ring-primary/40 [&:not(.rdp-selected)>button]:text-primary",
        outside: "text-muted-foreground/40",
        disabled: "text-muted-foreground/40",
        hidden: "invisible",
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation }) => {
          if (orientation === "left")
            return <ChevronLeftIcon className="size-3.5" />;
          return <ChevronRightIcon className="size-3.5" />;
        },
      }}
      {...props}
    />
  );
}

Calendar.displayName = "Calendar";

export { Calendar };
