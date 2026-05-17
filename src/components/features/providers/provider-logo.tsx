import Image from "next/image";

import { cn } from "@/lib/utils";
import {
  resolveProvider,
  type ProviderId,
  type ProviderSnapshot,
} from "@/lib/constants/providers";

const SIZE_PX: Record<NonNullable<ProviderLogoProps["size"]>, number> = {
  xs: 22,
  sm: 30,
  md: 40,
  lg: 56,
  xl: 88,
};

interface ProviderLogoProps {
  provider: ProviderSnapshot | { id: ProviderId } | ProviderId;
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  className?: string;
  /** When true, render with the provider's brand background as a chip. */
  framed?: boolean;
}

/**
 * Renders the provider's brand mark. Reads metadata from the central registry
 * so callers never need to hardcode a logo path. Uses next/image for
 * responsive sizing + automatic optimisation.
 */
export function ProviderLogo({
  provider,
  size = "md",
  className,
  framed = false,
}: ProviderLogoProps) {
  const meta = resolveProvider(
    typeof provider === "string" ? { id: provider } : provider,
  );
  const px = SIZE_PX[size];

  if (framed) {
    // White chip + subtle ring works for any brand asset (transparent
    // background or not). The brand colour appears elsewhere (Card top
    // stripe, email header strip) so we don't lose the colour cue.
    return (
      <span
        className={cn(
          "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-md bg-white ring-1 ring-black/10",
          className,
        )}
        style={{ width: px, height: px }}
        aria-hidden="true"
      >
        <Image
          src={meta.logo}
          alt=""
          width={px}
          height={px}
          unoptimized
          className="size-full object-contain"
        />
      </span>
    );
  }

  return (
    <Image
      src={meta.logo}
      alt={meta.name}
      width={px}
      height={px}
      unoptimized
      className={cn("shrink-0 rounded-md object-contain", className)}
    />
  );
}
