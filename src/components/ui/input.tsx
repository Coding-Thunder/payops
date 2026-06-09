import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Input, refined polish.
 *
 *   - Radius tightened to 6px (`--radius-input`). Just a hair
 *     squarer than buttons (9px) so inputs read as "form chrome"
 *     and buttons read as "actionable". Same-radius-everywhere is
 *     the loudest AI-template tell.
 *   - Resting border is a true hairline (1px); focus state replaces
 *     it with a *colored* hairline + a soft 2px ring at 40% opacity
 *     for a refined "intent" look (vs the default 4px solid ring).
 *   - Letter-spacing matches body so the input doesn't read as a
 *     foreign typeface inside the rest of the page.
 */
const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        ref={ref}
        data-slot="input"
        className={cn(
          "flex h-8 w-full border border-input bg-background px-2.5 py-1",
          "text-[13px] leading-none tracking-[-0.006em]",
          "shadow-[inset_0_1px_1px_rgba(0,0,0,0.02)]",
          "transition-[border-color,box-shadow] duration-150",
          "placeholder:text-muted-foreground/80",
          "file:border-0 file:bg-transparent file:text-[13px] file:font-medium file:text-foreground",
          "focus-visible:outline-none focus-visible:border-foreground/35 focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:shadow-none",
          "disabled:cursor-not-allowed disabled:opacity-50 disabled:bg-muted",
          "aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20",
          "[border-radius:var(--radius-input)]",
          className,
        )}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
