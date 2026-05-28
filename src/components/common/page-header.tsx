import { cn } from "@/lib/utils";

interface PageHeaderProps {
  title: string;
  description?: string;
  eyebrow?: string;
  actions?: React.ReactNode;
  className?: string;
}

/**
 * Page header — operator-grade. Neutral by default; let the page
 * content carry the brand voice. Tightens the editorial scale of
 * the previous version (28→24px h1, 14→13px description) so the
 * page chrome reads as ops console, not marketing landing.
 *
 * The previous `accent` prop is removed — page identity now lives
 * in the breadcrumb + the body content, not in colored eyebrow text.
 */
export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <header
      className={cn(
        "flex flex-col gap-3 pb-5 border-b border-border sm:flex-row sm:items-end sm:justify-between",
        className,
      )}
    >
      <div className="space-y-1.5 min-w-0">
        {eyebrow ? (
          <p className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="text-[22px] sm:text-[24px] font-semibold leading-[1.1] tracking-[-0.018em] text-foreground truncate">
          {title}
        </h1>
        {description ? (
          <p className="text-[13px] text-muted-foreground max-w-2xl leading-relaxed">
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
