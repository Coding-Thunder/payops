import { cva, type VariantProps } from "class-variance-authority";
import {
  ArrowDownRightIcon,
  ArrowUpRightIcon,
  MinusIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";

const tone = cva("", {
  variants: {
    variant: {
      default: "text-foreground",
      warning: "text-warning-foreground",
      success: "text-success",
      destructive: "text-destructive",
      info: "text-info",
    },
  },
  defaultVariants: { variant: "default" },
});

interface StatCardProps extends VariantProps<typeof tone> {
  label: string;
  value: React.ReactNode;
  /** Sub-label below the value (e.g. "12 paid orders"). */
  caption?: string;
  /** Optional trend indicator ("up", "down", "flat"). */
  trend?: {
    direction: "up" | "down" | "flat";
    label: string;
  };
  className?: string;
}

/**
 * KPI tile. Compact and uniform — every dashboard / analytics page renders
 * stats through this component so spacing, type scale, and trend treatment
 * stay consistent.
 */
export function StatCard({
  label,
  value,
  caption,
  trend,
  variant = "default",
  className,
}: StatCardProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 rounded-lg border border-border bg-card px-4 py-3.5",
        className,
      )}
    >
      <p className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <div className="flex items-baseline gap-2">
        <p
          className={cn(
            "text-[22px] font-semibold leading-none tracking-tight tabular-nums",
            tone({ variant }),
          )}
        >
          {value}
        </p>
        {trend ? <TrendBadge {...trend} /> : null}
      </div>
      {caption ? (
        <p className="text-[11.5px] text-muted-foreground">{caption}</p>
      ) : null}
    </div>
  );
}

function TrendBadge({
  direction,
  label,
}: {
  direction: "up" | "down" | "flat";
  label: string;
}) {
  const Icon =
    direction === "up"
      ? ArrowUpRightIcon
      : direction === "down"
        ? ArrowDownRightIcon
        : MinusIcon;
  const cls =
    direction === "up"
      ? "text-success bg-success-soft ring-success-border/50"
      : direction === "down"
        ? "text-destructive bg-destructive-soft ring-destructive-border/50"
        : "text-muted-foreground bg-surface-1 ring-border";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10.5px] font-medium ring-1 ring-inset tabular-nums",
        cls,
      )}
    >
      <Icon className="size-3" />
      {label}
    </span>
  );
}
