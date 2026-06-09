import { cn } from "@/lib/utils";

interface IllustrationProps {
  className?: string;
}

/** Decorative dot-grid background, useful as a subtle hero accent. */
export function DotGrid({ className }: IllustrationProps) {
  return (
    <svg
      viewBox="0 0 600 400"
      aria-hidden="true"
      className={cn("pointer-events-none", className)}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <pattern
          id="dotgrid"
          width="24"
          height="24"
          patternUnits="userSpaceOnUse"
        >
          <circle cx="1" cy="1" r="1" fill="currentColor" fillOpacity="0.4" />
        </pattern>
      </defs>
      <rect width="600" height="400" fill="url(#dotgrid)" />
    </svg>
  );
}

/** Soft success-tick illustration for "payment received" screens. */
export function SuccessIllustration({ className }: IllustrationProps) {
  return (
    <svg
      viewBox="0 0 160 120"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={cn("h-28 w-auto", className)}
    >
      <defs>
        <linearGradient id="successFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.18" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <rect
        x="14"
        y="22"
        width="132"
        height="78"
        rx="14"
        fill="url(#successFill)"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="1.5"
      />
      <rect
        x="24"
        y="34"
        width="40"
        height="6"
        rx="3"
        fill="currentColor"
        fillOpacity="0.25"
      />
      <rect
        x="24"
        y="46"
        width="68"
        height="6"
        rx="3"
        fill="currentColor"
        fillOpacity="0.18"
      />
      <rect
        x="24"
        y="58"
        width="50"
        height="6"
        rx="3"
        fill="currentColor"
        fillOpacity="0.18"
      />
      <circle cx="118" cy="68" r="22" fill="currentColor" fillOpacity="0.15" />
      <circle cx="118" cy="68" r="14" fill="currentColor" />
      <path
        d="m111.5 68.5 4.5 4.5 8.5-9"
        stroke="white"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

/** Subtle empty-state illustration: clipboard / receipt with checkmarks. */
export function EmptyReceiptIllustration({ className }: IllustrationProps) {
  return (
    <svg
      viewBox="0 0 160 140"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={cn("h-28 w-auto", className)}
    >
      <rect
        x="40"
        y="20"
        width="80"
        height="110"
        rx="10"
        fill="currentColor"
        fillOpacity="0.06"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="1.4"
      />
      <rect
        x="50"
        y="36"
        width="44"
        height="6"
        rx="3"
        fill="currentColor"
        fillOpacity="0.22"
      />
      {[58, 76, 94].map((y) => (
        <g key={y}>
          <circle cx="56" cy={y} r="3" fill="currentColor" fillOpacity="0.3" />
          <rect
            x="64"
            y={y - 3}
            width="46"
            height="6"
            rx="3"
            fill="currentColor"
            fillOpacity="0.15"
          />
        </g>
      ))}
      <rect
        x="50"
        y="108"
        width="60"
        height="8"
        rx="4"
        fill="currentColor"
        fillOpacity="0.12"
      />
    </svg>
  );
}

/** Cancelled-payment illustration: dashed card with a soft X. */
export function CancelledIllustration({ className }: IllustrationProps) {
  return (
    <svg
      viewBox="0 0 160 120"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={cn("h-28 w-auto", className)}
    >
      <rect
        x="20"
        y="22"
        width="120"
        height="76"
        rx="14"
        fill="currentColor"
        fillOpacity="0.05"
        stroke="currentColor"
        strokeOpacity="0.3"
        strokeWidth="1.4"
        strokeDasharray="4 4"
      />
      <rect
        x="32"
        y="36"
        width="36"
        height="6"
        rx="3"
        fill="currentColor"
        fillOpacity="0.2"
      />
      <rect
        x="32"
        y="50"
        width="56"
        height="6"
        rx="3"
        fill="currentColor"
        fillOpacity="0.14"
      />
      <circle cx="118" cy="60" r="18" fill="currentColor" fillOpacity="0.1" />
      <path
        d="m111 53 14 14M125 53l-14 14"
        stroke="currentColor"
        strokeOpacity="0.55"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
