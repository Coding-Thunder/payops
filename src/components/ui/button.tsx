import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Button, refined polish pass.
 *
 *   - Radius bumped from `rounded-md` (8px) to a custom 9px via the
 *     `--radius-button` token. Just barely softer than inputs (6px),
 *     so buttons read as interactive surfaces vs form chrome. The
 *     same-radius-as-input tell is one of the loudest AI signals.
 *   - Primary gets a *subtle* inset highlight (1px white at the top
 *     edge) for dimensionality without skeuomorph.
 *   - Press feedback: 1px translate-down on `:active`. Tactile, not
 *     a `:hover:scale` clown bounce.
 *   - Shadow scale calibrated to the new token system, `shadow-xs`
 *     reads as "barely there", `shadow-sm` is the new default for
 *     primary CTAs.
 */
const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-1.5 whitespace-nowrap",
    "text-[13px] font-semibold leading-none tracking-[-0.005em]",
    "transition-[background,color,box-shadow,transform] duration-150 ease-out",
    "disabled:pointer-events-none disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
    "[&_svg:not([class*='size-'])]:size-3.5",
    "outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 focus-visible:ring-offset-background",
    "select-none",
    "[border-radius:var(--radius-button)]",
  ].join(" "),
  {
    variants: {
      variant: {
        default: [
          "bg-primary text-primary-foreground",
          "shadow-sm",
          "[box-shadow:var(--shadow-sm),var(--shadow-inset-hi)]",
          "hover:bg-primary/90",
          "active:translate-y-px active:[box-shadow:var(--shadow-xs),var(--shadow-inset-hi)]",
        ].join(" "),
        destructive: [
          "bg-destructive text-destructive-foreground",
          "[box-shadow:var(--shadow-sm),var(--shadow-inset-hi)]",
          "hover:bg-destructive/90 active:translate-y-px",
        ].join(" "),
        outline: [
          "border border-border bg-background text-foreground shadow-xs",
          "hover:border-border-strong hover:bg-muted",
        ].join(" "),
        secondary:
          "bg-secondary text-secondary-foreground shadow-xs hover:bg-muted",
        ghost: "text-foreground hover:bg-muted hover:text-foreground",
        link: "text-foreground underline-offset-4 hover:underline px-0 h-auto font-medium [border-radius:0]",
        success: [
          "bg-success text-success-foreground",
          "[box-shadow:var(--shadow-sm),var(--shadow-inset-hi)]",
          "hover:bg-success/90 active:translate-y-px",
        ].join(" "),
        // Brand-accent variants, for chromatic CTAs that earn weight
        // (dispute action, payment-link send, branding save).
        accent: [
          "text-white",
          "[background:linear-gradient(180deg,var(--m-orange)_0%,var(--m-orange-deep)_100%)]",
          "[box-shadow:var(--shadow-sm),var(--shadow-inset-hi)]",
          "hover:opacity-[0.94] active:translate-y-px",
        ].join(" "),
        cobalt: [
          "text-white",
          "[background:linear-gradient(180deg,var(--m-cobalt)_0%,var(--m-cobalt-deep)_100%)]",
          "[box-shadow:var(--shadow-sm),var(--shadow-inset-hi)]",
          "hover:opacity-[0.94] active:translate-y-px",
        ].join(" "),
        sage: [
          "text-white",
          "[background:linear-gradient(180deg,var(--m-sage)_0%,var(--m-sage-deep)_100%)]",
          "[box-shadow:var(--shadow-sm),var(--shadow-inset-hi)]",
          "hover:opacity-[0.94] active:translate-y-px",
        ].join(" "),
        ultraviolet: [
          "text-white",
          "[background:linear-gradient(180deg,var(--m-ultraviolet)_0%,var(--m-ultraviolet-deep)_100%)]",
          "[box-shadow:var(--shadow-sm),var(--shadow-inset-hi)]",
          "hover:opacity-[0.94] active:translate-y-px",
        ].join(" "),
      },
      size: {
        default: "h-8 px-3.5 has-[>svg]:px-3",
        sm: "h-7 px-2.5 has-[>svg]:px-2 text-[12px]",
        lg: "h-9 px-4 has-[>svg]:px-3.5",
        xl: "h-11 px-5 text-[14px]",
        icon: "size-8",
        "icon-sm": "size-7",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        data-slot="button"
        className={cn(buttonVariants({ variant, size, className }))}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
