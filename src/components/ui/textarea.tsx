import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Session-recording privacy: see the note on `data-clarity-mask` in
 * `@/components/ui/input`. Free-text areas carry the least predictable
 * content in the product — client notes, internal ops notes, dispute
 * commentary — so they are masked at the primitive too.
 */
const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    data-slot="textarea"
    className={cn(
      "flex min-h-[72px] w-full rounded-md border border-input bg-background px-2.5 py-2",
      "text-[13px] leading-relaxed tracking-tight shadow-xs transition-colors",
      "placeholder:text-muted-foreground",
      "focus-visible:outline-none focus-visible:border-foreground/40 focus-visible:ring-2 focus-visible:ring-ring/40",
      "disabled:cursor-not-allowed disabled:opacity-50",
      "aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20",
      className,
    )}
    {...props}
    // After the spread, so a call site cannot override it — see `@/components/ui/input`.
    data-clarity-mask="true"
  />
));
Textarea.displayName = "Textarea";

export { Textarea };
