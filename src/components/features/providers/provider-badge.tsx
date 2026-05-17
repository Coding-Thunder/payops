import { cn } from "@/lib/utils";
import {
  resolveProvider,
  UNKNOWN_PROVIDER,
  type ProviderId,
  type ProviderSnapshot,
} from "@/lib/constants/providers";

import { ProviderLogo } from "./provider-logo";

interface ProviderBadgeProps {
  provider: ProviderSnapshot | { id: ProviderId } | ProviderId;
  /** Render an inline chip with the provider's name beside the mark. */
  showName?: boolean;
  size?: "xs" | "sm" | "md" | "lg";
  className?: string;
  subtitle?: string;
}

const NAME_TEXT: Record<NonNullable<ProviderBadgeProps["size"]>, string> = {
  xs: "text-[11px]",
  sm: "text-[12.5px]",
  md: "text-[13px]",
  lg: "text-[14px]",
};

/**
 * Compact horizontal lockup: provider mark + name. The mark always carries
 * its own brand colour via `framed`, so a row of mixed providers still reads
 * cleanly at a glance.
 */
export function ProviderBadge({
  provider,
  showName = true,
  size = "md",
  className,
  subtitle,
}: ProviderBadgeProps) {
  const meta = resolveProvider(
    typeof provider === "string" ? { id: provider } : provider,
  );
  // Legacy orders created before the provider field existed render as
  // UNKNOWN. Surface a discreet em-dash instead of the verbose "Unspecified
  // provider" string so a column of legacy rows doesn't dominate the row.
  const isUnknown = meta.id === UNKNOWN_PROVIDER.id;
  if (isUnknown) {
    return (
      <span
        className={cn(
          "inline-flex items-center text-muted-foreground/70",
          NAME_TEXT[size],
          className,
        )}
        aria-label="Provider not recorded"
      >
        —
      </span>
    );
  }

  return (
    <span
      className={cn("inline-flex items-center gap-2 min-w-0", className)}
    >
      <ProviderLogo provider={meta} size={size === "lg" ? "md" : size} framed />
      {showName ? (
        <span className="flex flex-col leading-tight min-w-0">
          <span
            className={cn(
              "font-medium text-foreground truncate",
              NAME_TEXT[size],
            )}
          >
            {meta.name}
          </span>
          {subtitle ? (
            <span className="text-[11px] text-muted-foreground truncate">
              {subtitle}
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}
