import { cn } from "@/lib/utils";

interface PageHeaderProps {
  title: string;
  description?: string;
  eyebrow?: string;
  actions?: React.ReactNode;
  className?: string;
  /** Use the `accent` color (from the marketing palette) for the
   *  eyebrow — propagates the brand language into authed pages
   *  without painting every page header. Pass `cobalt` on payment
   *  surfaces, `orange` on disputes, `sage` on settled, etc. */
  accent?: "orange" | "sage" | "cobalt" | "ultraviolet" | "cream";
}

const ACCENT_VAR: Record<NonNullable<PageHeaderProps["accent"]>, string> = {
  orange: "var(--m-orange-deep)",
  sage: "var(--m-sage-deep)",
  cobalt: "var(--m-cobalt-deep)",
  ultraviolet: "var(--m-ultraviolet-deep)",
  cream: "var(--m-cream-accent)",
};

/**
 * Page header — editorial scale lifted from the landing page so authed
 * pages share the brand voice. Eyebrow tone can opt into one of the
 * marketing accents (orange for disputes, cobalt for payments, etc.)
 * to give the page chrome a hint of color without painting the body.
 */
export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
  className,
  accent,
}: PageHeaderProps) {
  return (
    <header
      className={cn(
        "flex flex-col gap-3 pb-6 border-b border-border sm:flex-row sm:items-end sm:justify-between",
        className,
      )}
    >
      <div className="space-y-2 min-w-0">
        {eyebrow ? (
          <p
            className="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-muted-foreground"
            style={accent ? { color: ACCENT_VAR[accent] } : undefined}
          >
            {eyebrow}
          </p>
        ) : null}
        <h1 className="text-[24px] sm:text-[26px] font-semibold leading-[1.1] tracking-[-0.018em] text-foreground truncate">
          {title}
        </h1>
        {description ? (
          <p className="text-[13.5px] text-muted-foreground max-w-2xl leading-relaxed">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </header>
  );
}
