import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const spinnerVariants = cva(
  "inline-block animate-spin rounded-full border-current border-r-transparent border-solid align-[-0.125em] motion-reduce:animate-[spin_1.5s_linear_infinite]",
  {
    variants: {
      size: {
        xs: "size-3 border",
        sm: "size-3.5 border",
        md: "size-4 border-2",
        lg: "size-5 border-2",
        xl: "size-7 border-[2.5px]",
      },
      tone: {
        current: "text-current",
        muted: "text-muted-foreground/70",
        primary: "text-primary",
        accent: "text-foreground/60",
      },
    },
    defaultVariants: { size: "sm", tone: "current" },
  },
);

export interface SpinnerProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof spinnerVariants> {
  label?: string;
}

export function Spinner({
  className,
  size,
  tone,
  label = "Loading",
  ...props
}: SpinnerProps) {
  return (
    <span
      role="status"
      aria-live="polite"
      aria-label={label}
      className={cn(spinnerVariants({ size, tone }), className)}
      {...props}
    >
      <span className="sr-only">{label}</span>
    </span>
  );
}

interface InlineSpinnerProps extends SpinnerProps {
  children?: React.ReactNode;
  /** Optional label shown next to the spinner. */
  text?: string;
}

export function InlineSpinner({
  text,
  className,
  size = "xs",
  tone = "muted",
  children,
  ...props
}: InlineSpinnerProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-[12px] text-muted-foreground",
        className,
      )}
    >
      <Spinner size={size} tone={tone} {...props} />
      {text ?? children}
    </span>
  );
}

interface CenteredSpinnerProps extends SpinnerProps {
  text?: string;
  /** Minimum height of the centering container. Defaults to a comfortable card height. */
  minHeight?: string | number;
}

export function CenteredSpinner({
  text,
  className,
  minHeight = "12rem",
  size = "lg",
  tone = "muted",
  ...props
}: CenteredSpinnerProps) {
  return (
    <div
      className={cn(
        "flex w-full flex-col items-center justify-center gap-2 text-[12.5px] text-muted-foreground",
        className,
      )}
      style={{ minHeight }}
      aria-busy
    >
      <Spinner size={size} tone={tone} {...props} />
      {text ? <span>{text}</span> : null}
    </div>
  );
}
