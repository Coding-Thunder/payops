import { cn } from "@/lib/utils";

interface LogoMarkProps {
  className?: string;
  /** Render with a circular accent ring. Useful on dark backgrounds. */
  decorated?: boolean;
}

/**
 * The PayOps brand mark. Stylised "P" formed by overlapping rounded shapes
 * suggesting a card and a route - works in mono or two-tone using the
 * surrounding text colour.
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
        <circle cx="24" cy="24" r="23" stroke="currentColor" strokeOpacity="0.18" strokeWidth="1" />
      ) : null}
      <path
        d="M14 12h12.5a8.5 8.5 0 0 1 0 17H19v7h-5V12Z"
        fill="currentColor"
      />
      <circle cx="26.5" cy="20.5" r="3.25" fill="currentColor" fillOpacity="0.35" />
      <rect
        x="14"
        y="32"
        width="11"
        height="2.5"
        rx="1.25"
        fill="currentColor"
        fillOpacity="0.45"
      />
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
  brand = "PayOps Rentals",
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
