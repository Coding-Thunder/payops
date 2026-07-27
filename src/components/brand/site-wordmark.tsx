import { cn } from "@/lib/utils";

/**
 * The canonical TraceTxn wordmark: the emerald three-node "trace" mark plus
 * the DM Sans wordmark used in the landing page header and footer. Extracted
 * into one shared component so every surface — marketing AND auth — renders
 * the exact same logo at the same size, spacing, and capitalization.
 *
 * Defaults to white text for dark backgrounds (landing, the login cover
 * panel). On a light background pass `textClassName="text-foreground"`; the
 * emerald mark reads on either.
 */
export function SiteWordmark({
  className,
  textClassName,
}: {
  className?: string;
  textClassName?: string;
}) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <span className="relative grid size-7 place-items-center rounded-[7px] bg-emerald-400/10 ring-1 ring-inset ring-emerald-400/25">
        <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
          <path
            d="M5 17.5 10 9l4 5 5-8.5"
            fill="none"
            stroke="#34d399"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="5" cy="17.5" r="1.6" fill="#34d399" />
          <circle cx="19" cy="5.5" r="1.6" fill="#34d399" />
        </svg>
      </span>
      <span
        className={cn(
          "font-display text-[15px] font-semibold tracking-[-0.01em] text-white",
          textClassName,
        )}
      >
        TraceTxn
      </span>
    </span>
  );
}
