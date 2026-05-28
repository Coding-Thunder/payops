import { cn } from "@/lib/utils";

export type MarketingTheme =
  | "obsidian"
  | "orange"
  | "sage"
  | "cobalt"
  | "cream"
  | "ultraviolet"
  | "closing"
  | "graphite"
  | "default";

interface MarketingSectionProps {
  id?: string;
  eyebrow?: string;
  title?: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  align?: "left" | "center";
  /** Top divider is suppressed by default on themed sections — the
   *  color wash IS the section boundary. Pass `divider` only when a
   *  themed section needs an explicit rule (rare). */
  divider?: boolean;
  /** Section color theme — drives the background wash, eyebrow accent,
   *  and surface tones via CSS variables defined in `globals.css`. */
  theme?: MarketingTheme;
  /** When true, the section pads down its top spacing — pair with a
   *  preceding hero / sticky-pin moment where breathing room is
   *  baked into the previous frame. */
  tight?: boolean;
}

/**
 * Themed marketing section primitive. Each section can opt into a
 * color palette via the `theme` prop; the wash is applied via
 * `data-theme` so the CSS variables in `globals.css` cascade
 * automatically (background, foreground, eyebrow accent, surface
 * tones for cards).
 *
 * No more uniform card-grid wallpaper — sections compose into
 * chapters, each with its own color story.
 */
export function MarketingSection({
  id,
  eyebrow,
  title,
  description,
  children,
  className,
  align = "left",
  divider = false,
  theme = "default",
  tight = false,
}: MarketingSectionProps) {
  return (
    <section
      id={id}
      data-theme={theme === "default" ? undefined : theme}
      className={cn(
        "relative isolate scroll-mt-24",
        tight ? "py-16 sm:py-20 lg:py-24" : "py-28 sm:py-32 lg:py-40",
        className,
      )}
    >
      {divider ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 mx-auto h-px max-w-[1280px]"
          style={{ background: "var(--m-border)" }}
        />
      ) : null}
      <div className="mx-auto w-full max-w-[1280px] px-6 lg:px-10">
        {(eyebrow || title || description) && (
          <header
            className={cn(
              "mb-14 sm:mb-20",
              align === "center" ? "mx-auto max-w-3xl text-center" : "max-w-3xl",
            )}
          >
            {eyebrow ? (
              <p
                data-reveal
                data-reveal-order={0}
                className="mb-5 text-[11.5px] font-semibold uppercase tracking-[0.22em]"
                style={{ color: "var(--m-eyebrow, var(--muted-foreground))" }}
              >
                {eyebrow}
              </p>
            ) : null}
            {title ? (
              <h2
                data-reveal
                data-reveal-order={1}
                className="text-balance text-[clamp(2rem,4.2vw,3.5rem)] font-semibold leading-[1.04] tracking-[-0.025em]"
              >
                {title}
              </h2>
            ) : null}
            {description ? (
              <p
                data-reveal
                data-reveal-order={2}
                className="mt-6 max-w-2xl text-[15.5px] leading-relaxed"
                style={{ color: "var(--m-fg-soft, var(--muted-foreground))" }}
              >
                {description}
              </p>
            ) : null}
          </header>
        )}
        {children}
      </div>
    </section>
  );
}

/* ────────────── Reusable display helpers shared by sections ────────────── */

interface AccentWordProps {
  children: React.ReactNode;
  className?: string;
}

/** Headline accent: paints the wrapped word(s) in the active section's
 *  accent color via CSS variable. Use sparingly — once per headline. */
export function AccentWord({ children, className }: AccentWordProps) {
  return (
    <span
      className={cn("inline", className)}
      style={{ color: "var(--m-eyebrow, currentColor)" }}
    >
      {children}
    </span>
  );
}
