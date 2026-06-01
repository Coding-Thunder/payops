import { cn } from "@/lib/utils";

interface AuroraProps {
  className?: string;
  /** Lower numbers = darker base, higher numbers = brighter. */
  intensity?: "low" | "medium";
}

/**
 * Aurora background, three soft blurred conic gradients layered over the
 * surface. Used very sparingly: login hero, dashboard greeting band, premium
 * empty states. No animation, calm by design.
 */
export function Aurora({ className, intensity = "low" }: AuroraProps) {
  const blur = intensity === "low" ? "blur-[110px]" : "blur-[90px]";
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-0 overflow-hidden",
        className,
      )}
    >
      <div
        className={cn(
          "absolute -top-32 -left-32 size-[420px] rounded-full opacity-[0.18]",
          blur,
        )}
        style={{
          background:
            "radial-gradient(closest-side, oklch(0.7 0.22 280), transparent)",
        }}
      />
      <div
        className={cn(
          "absolute -top-12 right-[10%] size-[340px] rounded-full opacity-[0.14]",
          blur,
        )}
        style={{
          background:
            "radial-gradient(closest-side, oklch(0.74 0.17 200), transparent)",
        }}
      />
      <div
        className={cn(
          "absolute bottom-[-20%] left-[20%] size-[480px] rounded-full opacity-[0.1]",
          blur,
        )}
        style={{
          background:
            "radial-gradient(closest-side, oklch(0.75 0.18 28), transparent)",
        }}
      />
    </div>
  );
}
