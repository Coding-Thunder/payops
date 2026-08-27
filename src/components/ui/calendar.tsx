"use client";

import * as React from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { DayPicker } from "react-day-picker";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type CalendarProps = React.ComponentProps<typeof DayPicker>;

/**
 * shadcn-style Calendar for react-day-picker v10.
 *
 * Why descendant selectors (`[&>button]:`) instead of modifiersClassNames:
 * v9+ applies the `rdp-selected` / `rdp-today` classes to the day's TD
 * wrapper, not the button. Targeting the button via `[&>button]:` produces
 * CSS like `.rdp-day.rdp-selected > button { … }` which wins specificity
 * cleanly without `!important`.
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
        months: "flex flex-col sm:flex-row gap-2",
        month: "flex flex-col gap-4",
        month_caption: "flex justify-center pt-1 relative items-center h-8",
        caption_label: "text-sm font-medium",
        nav: "flex items-center gap-1",
        button_previous: cn(
          buttonVariants({ variant: "outline", size: "icon-sm" }),
          "absolute left-1 size-7 bg-transparent p-0 opacity-60 hover:opacity-100",
        ),
        button_next: cn(
          buttonVariants({ variant: "outline", size: "icon-sm" }),
          "absolute right-1 size-7 bg-transparent p-0 opacity-60 hover:opacity-100",
        ),
        month_grid: "w-full border-collapse",
        weekdays: "flex",
        weekday:
          "text-muted-foreground rounded-md w-9 font-normal text-[0.78rem]",
        week: "flex w-full mt-1.5",
        day: cn(
          "relative h-9 w-9 p-0 text-center text-sm focus-within:relative focus-within:z-20",
          // Cell wraps the button; we target the button via descendant
          // selector so styles win specificity over day_button base.
          "[&>button]:size-9 [&>button]:p-0 [&>button]:font-normal [&>button]:rounded-md",
          "[&>button]:transition-colors [&>button]:duration-150",
          "[&>button]:hover:bg-accent [&>button]:hover:text-accent-foreground",
        ),
        day_button: cn(
          buttonVariants({ variant: "ghost" }),
          "size-9 p-0 font-normal",
        ),

        // Selected: filled black pill, white text. Descendant selector
        // gives us `.rdp-day.rdp-selected > button` which trumps
        // `.rdp-day > button:hover` from the cell, so hover stays solid.
        selected: cn(
          "[&>button]:bg-foreground [&>button]:text-background",
          "[&>button]:font-medium",
          "[&>button]:hover:bg-foreground [&>button]:hover:text-background",
          "[&>button]:focus:bg-foreground [&>button]:focus:text-background",
        ),
        // Today: only a subtle accent tint — never wins over selected.
        today: "[&>button]:bg-accent/60 [&>button]:font-medium",
        // An outside day belongs to the neighbouring month but is a normal,
        // selectable date — react-day-picker fills the first and last rows
        // with them. It previously rendered at 40% muted with its hover
        // feedback removed, which is all but indistinguishable from the
        // disabled style below, so the first days of next month read as
        // unavailable when they are not. De-emphasised, but visibly alive.
        outside: cn(
          "[&>button]:text-muted-foreground",
          "[&>button]:hover:bg-accent [&>button]:hover:text-accent-foreground",
        ),
        // Scoped to `button:disabled` rather than `button` so it outranks
        // the outside rule on specificity. A day can be both — the leading
        // days of the displayed month when they fall before minDate — and
        // with two equally specific rules the winner would come down to
        // whatever order Tailwind happened to emit them in.
        disabled: cn(
          "[&>button:disabled]:text-muted-foreground/30",
          "[&>button:disabled]:cursor-not-allowed",
          "[&>button:disabled]:hover:bg-transparent",
          "[&>button:disabled]:hover:text-muted-foreground/30",
        ),
        hidden: "invisible",
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation }) => {
          if (orientation === "left")
            return <ChevronLeftIcon className="size-4" />;
          return <ChevronRightIcon className="size-4" />;
        },
      }}
      {...props}
    />
  );
}

Calendar.displayName = "Calendar";

export { Calendar };
