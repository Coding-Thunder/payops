import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Badge, Stripe / Linear style: soft pastel fills, hairline ring,
 * compact pill. Uses semantic variants so status badges stay consistent
 * regardless of where they appear (table cell, page header, etc.).
 */
const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium leading-none tabular-nums tracking-tight whitespace-nowrap ring-1 ring-inset",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground ring-primary/15 hover:bg-primary/90",
        secondary:
          "bg-surface-1 text-foreground ring-border",
        outline:
          "bg-transparent text-foreground ring-border-strong",
        muted:
          "bg-surface-1 text-muted-foreground ring-border",
        success:
          "bg-success-soft text-success ring-success-border/60",
        warning:
          "bg-warning-soft text-warning-foreground ring-warning-border/60",
        destructive:
          "bg-destructive-soft text-destructive ring-destructive-border/60",
        info:
          "bg-info-soft text-info ring-info-border/60",
        // ─── Marketing palette accents, for chromatic moments in the
        // authed app (paid receipt, dispute opened, settled batch). The
        // soft + ring colors lean on CSS color-mix against the
        // marketing tokens so they stay perfectly tuned to the brand.
        accent:
          "[background:color-mix(in_oklch,var(--m-orange)_18%,transparent)] [color:var(--m-orange-deep)] [--tw-ring-color:color-mix(in_oklch,var(--m-orange)_35%,transparent)]",
        sage:
          "[background:color-mix(in_oklch,var(--m-sage)_22%,transparent)] [color:var(--m-sage-deep)] [--tw-ring-color:color-mix(in_oklch,var(--m-sage)_40%,transparent)]",
        cobalt:
          "[background:color-mix(in_oklch,var(--m-cobalt)_18%,transparent)] [color:var(--m-cobalt-deep)] [--tw-ring-color:color-mix(in_oklch,var(--m-cobalt)_35%,transparent)]",
        ultraviolet:
          "[background:color-mix(in_oklch,var(--m-ultraviolet)_18%,transparent)] [color:var(--m-ultraviolet-deep)] [--tw-ring-color:color-mix(in_oklch,var(--m-ultraviolet)_35%,transparent)]",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span
      data-slot="badge"
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
