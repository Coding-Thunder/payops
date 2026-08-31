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
 *
 * Session-recording privacy: `data-clarity-mask="true"` tells Microsoft
 * Clarity to mask this node and every descendant, and masked content is
 * never uploaded. It is set here, on the shared primitive, so all ~150 call
 * sites are covered by one line instead of by remembering at each form —
 * including `PasswordInput`, which renders through this component and would
 * otherwise expose the plaintext once the eye-toggle flips it to
 * `type="text"`.
 *
 * The attribute is an unconditional literal on purpose. Clarity's shipped
 * implementation tests for attribute PRESENCE and ignores the value, so a
 * React boolean (`data-clarity-mask={sensitive}`) renders
 * `data-clarity-mask="false"` and still masks — while the mirror-image
 * `data-clarity-unmask="false"` would UNMASK. Never make either conditional.
 *
 * Belt and braces: Clarity is only loaded on the public marketing routes
 * (`@/lib/analytics/clarity`), so on nearly every form here there is no
 * recorder running at all. This covers the window where a visitor who was
 * recorded on the marketing site follows a client-side link into a form
 * before the document reloads.
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
        // AFTER the spread on purpose: masking is not a default a call site
        // may override. Placed above `{...props}`, a stray
        // `data-clarity-mask={false}` — or a `data-clarity-unmask`, which
        // fails OPEN — would silently expose the field.
        data-clarity-mask="true"
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
