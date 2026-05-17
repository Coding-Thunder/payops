"use client";

import * as React from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { DayPicker } from "react-day-picker";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type CalendarProps = React.ComponentProps<typeof DayPicker>;

/**
 * Calendar tuned to feel like a polished enterprise scheduling component
 * (Stripe / Linear / Vercel quality). Selection uses a soft blue pill, today
 * is marked with a low-contrast ring + indigo numeral, hover is a subtle
 * muted background. Cell hit area is 36px so it stays touch-friendly while
 * the inner pill stays compact at 32px.
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
        month: "flex flex-col gap-3",
        month_caption:
          "flex items-center justify-center relative h-9 mb-0.5",
        caption_label:
          "text-[13px] font-semibold tracking-tight text-foreground",
        nav: "flex items-center gap-1",
        button_previous: cn(
          buttonVariants({ variant: "ghost", size: "icon-sm" }),
          "absolute left-1 top-1 size-7 bg-transparent p-0",
          "text-muted-foreground hover:bg-muted hover:text-foreground",
          "rounded-md transition-colors duration-150",
        ),
        button_next: cn(
          buttonVariants({ variant: "ghost", size: "icon-sm" }),
          "absolute right-1 top-1 size-7 bg-transparent p-0",
          "text-muted-foreground hover:bg-muted hover:text-foreground",
          "rounded-md transition-colors duration-150",
        ),
        month_grid: "w-full border-collapse",
        weekdays: "flex",
        weekday:
          "text-muted-foreground/70 w-9 h-7 flex items-center justify-center font-medium text-[10.5px] uppercase tracking-[0.07em]",
        week: "flex w-full",
        day: "relative h-9 w-9 p-0 text-center text-[13px] flex items-center justify-center focus-within:relative focus-within:z-20",
        day_button: cn(
          // Layout
          "size-8 rounded-lg p-0 inline-flex items-center justify-center",
          // Typography
          "font-medium text-[13px] tabular-nums tracking-tight",
          "text-foreground/85",
          // Motion
          "transition-[background-color,color,box-shadow] duration-150 ease-out",
          // Hover (non-selected, non-disabled)
          "hover:bg-muted/70 hover:text-foreground",
          // Focus
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
          // Disabled
          "disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed",
        ),
        // The wrapper classes — keep empty, all visual state lives on
        // the button via modifiersClassNames below.
        selected: "",
        today: "",
        outside: "text-foreground/30",
        disabled: "text-foreground/30",
        hidden: "invisible",
        ...classNames,
      }}
      // modifiersClassNames is applied directly to the day BUTTON, so the
      // styles here win over the base day_button classes regardless of
      // Tailwind's class-generation order.
      modifiersClassNames={{
        selected: cn(
          // Use indigo so the selection feels distinct from the dark primary
          // (admin nav, buttons) and reads as an "informational" highlight.
          "!bg-indigo-600 !text-white font-semibold",
          "shadow-[0_1px_2px_rgba(79,70,229,0.35),inset_0_-1px_0_rgba(0,0,0,0.05)]",
          "hover:!bg-indigo-600 hover:!text-white",
          "focus-visible:!ring-indigo-500",
        ),
        today: cn(
          // Subtle dot accent under today's number when it's NOT selected.
          // We can't easily inject pseudo-content via Tailwind here, so we
          // use a ring + accent color instead.
          "!text-indigo-700 !ring-1 !ring-indigo-200/80",
        ),
        outside: "!text-foreground/25",
        disabled: "!text-foreground/25",
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
