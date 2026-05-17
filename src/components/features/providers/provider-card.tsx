import { cn } from "@/lib/utils";
import {
  resolveProvider,
  type ProviderId,
  type ProviderSnapshot,
} from "@/lib/constants/providers";

import { ProviderLogo } from "./provider-logo";

interface ProviderCardProps {
  provider: ProviderSnapshot | { id: ProviderId } | ProviderId;
  description?: string;
  className?: string;
  /** Right-aligned slot for booking-id, status badges, etc. */
  meta?: React.ReactNode;
}

/**
 * Hero-sized provider branding block. Used on the order details page to
 * anchor the booking to a single rental brand. The header sits inside a
 * thin colour wash drawn from the brand's primary so the page still feels
 * unified when stacked next to neutral surfaces.
 */
export function ProviderCard({
  provider,
  description,
  className,
  meta,
}: ProviderCardProps) {
  const p = resolveProvider(
    typeof provider === "string" ? { id: provider } : provider,
  );

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-xl border border-border bg-card",
        className,
      )}
    >
      <div
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-1.5"
        style={{ backgroundColor: p.primaryColor }}
      />
      <div className="flex items-start gap-4 px-5 py-4 pt-5">
        <ProviderLogo provider={p} size="xl" framed />
        <div className="min-w-0 flex-1">
          <p className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
            Rental provider
          </p>
          <h3 className="mt-1 truncate text-[15px] font-semibold text-foreground">
            {p.name}
          </h3>
          <p className="mt-0.5 truncate text-[12.5px] text-muted-foreground">
            {description ?? p.tagline}
          </p>
        </div>
        {meta ? (
          <div className="shrink-0 text-right text-[12px] text-muted-foreground">
            {meta}
          </div>
        ) : null}
      </div>
    </div>
  );
}
