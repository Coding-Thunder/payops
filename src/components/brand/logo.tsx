import { cn } from "@/lib/utils";

/**
 * TraceTxn Brand v1, primary mark + wordmark.
 *
 * The mark is a four-node transaction trace:
 *
 *     ●──●──●──●         (line + 4 dots, viewBox 40×40)
 *
 * Reading left-to-right: source → intent → settlement (emerald) →
 * destination. The third node is the operational moment, the only
 * one that's emerald, the "trace head" where evidence is captured.
 *
 * Wordmark: "Trace" in body weight + Deep Navy, "Txn" in semibold +
 * Emerald (default) or Deep Navy (monochrome). DM Sans throughout
 * with tight tracking. These pairings come straight from the brand-v1
 * system; do not drift from them without re-spec'ing the identity.
 */

const BRAND_NAVY = "#0F172A";
const BRAND_EMERALD = "#10B981";

interface LogoMarkProps {
  className?: string;
  /** When true, every node + line draws in `currentColor` so the mark
   *  can sit on dark backgrounds (white-on-navy variant). When false
   *  (default), uses the brand-v1 spec colors: navy + emerald accent. */
  monochrome?: boolean;
}

export function LogoMark({ className, monochrome = false }: LogoMarkProps) {
  const stroke = monochrome ? "currentColor" : BRAND_NAVY;
  const accent = monochrome ? "currentColor" : BRAND_EMERALD;
  return (
    <svg
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={cn("size-6 shrink-0", className)}
    >
      {/* Main trace: source → intent → settlement → destination */}
      <path
        d="M6 14L16 14L24 20L34 14"
        stroke={stroke}
        strokeWidth="2"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
      {/* Drop line: the operational moment off the settlement node */}
      <path
        d="M16 14V24"
        stroke={accent}
        strokeWidth="2"
        strokeLinecap="square"
      />
      <circle cx="6" cy="14" r="3" fill={stroke} />
      <circle cx="16" cy="14" r="3" fill={stroke} />
      <circle cx="24" cy="20" r="3" fill={accent} />
      <circle cx="34" cy="14" r="3" fill={stroke} />
    </svg>
  );
}

interface LogoLockupProps {
  className?: string;
  brand?: string;
  subtitle?: string;
  size?: "sm" | "md" | "lg";
  tone?: "default" | "inverted";
  /** When true (default), only the FIRST occurrence of "Txn" in the
   *  brand string is emerald, mirrors the brand-v1 wordmark.
   *  Tenants whose workspace name doesn't include "Txn" just see a
   *  single-tone wordmark in the appropriate color. */
  twoTone?: boolean;
}

/**
 * Brand wordmark. Renders the LogoMark + the brand label as a
 * two-tone wordmark, "Trace" navy + "Txn" emerald, when the brand
 * string is the platform name. Other workspace names render as a
 * single-tone label.
 */
export function LogoLockup({
  className,
  brand = "TraceTxn",
  subtitle,
  size = "md",
  tone = "default",
  twoTone = true,
}: LogoLockupProps) {
  const markSize =
    size === "lg" ? "size-9" : size === "sm" ? "size-6" : "size-7";
  const brandSize =
    size === "lg"
      ? "text-[20px]"
      : size === "sm"
        ? "text-[13px]"
        : "text-[15px]";

  // Two-tone applies ONLY when the wordmark contains "Txn", the
  // brand-v1 accented suffix. Otherwise the whole thing renders in
  // a single tone matching the surface.
  const txnIndex = twoTone ? brand.lastIndexOf("Txn") : -1;
  const head = txnIndex > 0 ? brand.slice(0, txnIndex) : brand;
  const tail = txnIndex > 0 ? brand.slice(txnIndex) : null;

  return (
    <div
      className={cn(
        "flex items-center gap-2.5",
        tone === "inverted" ? "text-white" : "text-foreground",
        className,
      )}
    >
      <LogoMark
        className={markSize}
        monochrome={tone === "inverted"}
      />
      <span className="flex flex-col leading-tight min-w-0">
        <span
          className={cn(
            "flex items-baseline font-display tracking-[-0.02em] truncate",
            brandSize,
          )}
        >
          <span className="font-medium">{head}</span>
          {tail ? (
            <span
              className={cn(
                "font-semibold",
                tone === "inverted"
                  ? "text-white"
                  : "text-[color:var(--brand-emerald)]",
              )}
            >
              {tail}
            </span>
          ) : null}
        </span>
        {subtitle ? (
          <span
            className={cn(
              "text-[10.5px] tracking-[0.14em] uppercase truncate font-medium",
              tone === "inverted" ? "text-white/60" : "text-muted-foreground",
            )}
          >
            {subtitle}
          </span>
        ) : null}
      </span>
    </div>
  );
}
