import { cn } from "@/lib/utils";

interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  /**
   * "shimmer" (default) sweeps a soft gradient across the surface for a more
   * polished, Stripe-grade loading look. "pulse" is the older opacity pulse,
   * kept for places that want a quieter beat. "none" disables motion (used
   * inside skeleton groups that already animate).
   */
  variant?: "shimmer" | "pulse" | "none";
}

function Skeleton({
  className,
  variant = "shimmer",
  ...props
}: SkeletonProps) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden
      className={cn(
        "rounded-md bg-surface-2",
        variant === "shimmer" && "skeleton-shimmer",
        variant === "pulse" && "animate-pulse",
        "motion-reduce:animate-none motion-reduce:bg-surface-2 motion-reduce:before:hidden",
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton };
