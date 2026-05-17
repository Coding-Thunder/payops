import { cn } from "@/lib/utils";

interface SectionProps {
  title: string;
  description?: string;
  /** Right-aligned slot in the header — useful for "Edit" buttons. */
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /** Use a flat surface (no border) for nested sections. */
  flat?: boolean;
}

/**
 * Section — Stripe-style settings panel: a titled card with a left-aligned
 * description column on desktop and a right-aligned content column. Pairs
 * well with form fields grouped by topic.
 *
 *  ┌──────────────────────────────────────────────────────────┐
 *  │  Title                       │  field                     │
 *  │  Description                 │  field                     │
 *  │                              │  field                     │
 *  └──────────────────────────────────────────────────────────┘
 */
export function Section({
  title,
  description,
  action,
  children,
  className,
  flat = false,
}: SectionProps) {
  return (
    <section
      className={cn(
        "rounded-lg",
        !flat && "border border-border bg-card",
        className,
      )}
    >
      <div className="grid grid-cols-1 gap-6 px-5 py-5 sm:px-6 sm:py-6 lg:grid-cols-[260px_1fr] lg:gap-8">
        <div className="space-y-1">
          <div className="flex items-start justify-between gap-2">
            <h2 className="text-[14px] font-semibold tracking-tight text-foreground">
              {title}
            </h2>
            {action ? <div className="shrink-0">{action}</div> : null}
          </div>
          {description ? (
            <p className="text-[12.5px] text-muted-foreground leading-relaxed">
              {description}
            </p>
          ) : null}
        </div>
        <div className="space-y-4 min-w-0">{children}</div>
      </div>
    </section>
  );
}

interface SectionGridProps {
  children: React.ReactNode;
  className?: string;
}

/** Stack sections with consistent spacing. */
export function SectionStack({ children, className }: SectionGridProps) {
  return (
    <div className={cn("space-y-4", className)}>{children}</div>
  );
}

interface FieldRowProps {
  label: string;
  description?: string;
  htmlFor?: string;
  children: React.ReactNode;
  className?: string;
}

/** Simple labelled row used inside a Section. */
export function FieldRow({
  label,
  description,
  htmlFor,
  children,
  className,
}: FieldRowProps) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <label
        htmlFor={htmlFor}
        className="text-[12.5px] font-medium tracking-tight text-foreground"
      >
        {label}
      </label>
      {children}
      {description ? (
        <p className="text-[11.5px] text-muted-foreground leading-relaxed">
          {description}
        </p>
      ) : null}
    </div>
  );
}
