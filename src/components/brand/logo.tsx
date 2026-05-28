import { cn } from "@/lib/utils";

interface LogoMarkProps {
  className?: string;
  /** Render with a circular accent ring. Useful on dark backgrounds. */
  decorated?: boolean;
}

/**
 * The TraceTxn brand mark. Bold "T" glyph with an emerald trace-head
 * dot at the right edge of the horizontal bar — the dot reads as the
 * live edge of the order's evidence chain, where the latest event
 * lives. Mono on `currentColor`; the accent stays emerald regardless
 * of context tone.
 */
export function LogoMark({ className, decorated = false }: LogoMarkProps) {
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={cn("size-6", className)}
    >
      {decorated ? (
        <circle
          cx="24"
          cy="24"
          r="23"
          stroke="currentColor"
          strokeOpacity="0.18"
          strokeWidth="1"
        />
      ) : null}
      {/* Horizontal bar — the trace */}
      <rect x="10" y="13" width="28" height="5" rx="2.5" fill="currentColor" />
      {/* Vertical stem — the transaction */}
      <rect x="21.5" y="13" width="5" height="24" rx="2.5" fill="currentColor" />
      {/* Trace-head accent — emerald, live edge of the chain */}
      <circle cx="38" cy="15.5" r="2.4" fill="oklch(0.74 0.15 152)" />
    </svg>
  );
}

interface LogoLockupProps {
  className?: string;
  brand?: string;
  subtitle?: string;
  size?: "sm" | "md" | "lg";
  tone?: "default" | "inverted";
}

/** Logo mark + wordmark + optional subtitle. */
export function LogoLockup({
  className,
  brand = "TraceTxn",
  subtitle,
  size = "md",
  tone = "default",
}: LogoLockupProps) {
  const markSize =
    size === "lg" ? "size-8" : size === "sm" ? "size-5" : "size-6";
  const brandSize =
    size === "lg" ? "text-lg" : size === "sm" ? "text-xs" : "text-sm";
  return (
    <div
      className={cn(
        "flex items-center gap-2.5",
        tone === "inverted" ? "text-primary-foreground" : "text-foreground",
        className,
      )}
    >
      <span
        className={cn(
          "inline-flex items-center justify-center rounded-md shrink-0",
          tone === "inverted"
            ? "bg-primary-foreground/10 text-primary-foreground"
            : "bg-primary/10 text-primary",
          size === "lg" ? "size-10" : size === "sm" ? "size-7" : "size-8",
        )}
      >
        <LogoMark className={markSize} />
      </span>
      <span className="flex flex-col leading-tight min-w-0">
        <span className={cn("font-semibold tracking-tight truncate", brandSize)}>
          {brand}
        </span>
        {subtitle ? (
          <span
            className={cn(
              "text-[11px] tracking-wider uppercase truncate",
              tone === "inverted"
                ? "text-primary-foreground/70"
                : "text-muted-foreground",
            )}
          >
            {subtitle}
          </span>
        ) : null}
      </span>
    </div>
  );
}
