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

/**
 * Operational KPI tile.
 *
 * The reference dashboard's KPI cards lead with a colored icon
 * block on the left, green/amber/purple/blue identity tiles that
 * encode the metric's role at a glance. This component now supports
 * that pattern via the optional `icon` + `iconTone` props. When
 * passed, the tile renders icon-on-left + content-on-right; when
 * omitted, the legacy compact layout still works for places like
 * the analytics page that show many stats in tight rows.
 */

type IconTone = "success" | "warning" | "destructive" | "info" | "purple";

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
  /** Optional icon + tone for the colored identity block. When
   *  set, the tile renders the reference-dashboard layout
   *  (icon-on-left, content-on-right). */
  icon?: React.ComponentType<{ className?: string }>;
  iconTone?: IconTone;
  className?: string;
}

const ICON_TONE: Record<
  IconTone,
  { bg: string; fg: string }
> = {
  success: { bg: "var(--success)", fg: "white" },
  warning: { bg: "var(--warning)", fg: "oklch(0.18 0.05 78)" },
  destructive: { bg: "var(--destructive)", fg: "white" },
  info: { bg: "var(--info)", fg: "white" },
  purple: { bg: "oklch(0.58 0.22 302)", fg: "white" },
};

export function StatCard({
  label,
  value,
  caption,
  trend,
  icon: Icon,
  iconTone,
  variant = "default",
  className,
}: StatCardProps) {
  if (Icon && iconTone) {
    const tones = ICON_TONE[iconTone];
    return (
      <div
        className={cn(
          "grid grid-cols-[auto_1fr] items-start gap-4 rounded-lg border border-border bg-card p-4 sm:p-5",
          className,
        )}
      >
        <span
          className="grid size-12 place-items-center rounded-xl shadow-[0_4px_12px_-4px_var(--icon-shadow)]"
          style={
            {
              background: tones.bg,
              color: tones.fg,
              ["--icon-shadow" as string]: `color-mix(in oklch, ${tones.bg} 50%, transparent)`,
            } as React.CSSProperties
          }
        >
          <Icon className="size-5" />
        </span>
        <div>
          <p className="text-[12px] font-medium text-muted-foreground">
            {label}
          </p>
          <div className="mt-1.5 flex items-baseline gap-2">
            <p
              className={cn(
                "text-[26px] font-semibold leading-none tracking-tight tabular-nums",
                tone({ variant }),
              )}
            >
              {value}
            </p>
            {trend ? <TrendBadge {...trend} /> : null}
          </div>
          {caption ? (
            <p className="mt-1.5 text-[11.5px] text-muted-foreground">
              {caption}
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  // Legacy compact layout, used in analytics + places that
  // render many tiles in a tight row without identity icons.
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
