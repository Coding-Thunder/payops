import { cn } from "@/lib/utils";

interface PageHeaderProps {
  title: string;
  description?: string;
  eyebrow?: string;
  actions?: React.ReactNode;
  className?: string;
}

/**
 * Page header. Optional `eyebrow` is a small uppercase label above the
 * title for context (e.g. "Orders › Detail"). Actions sit aligned to the
 * right and wrap on small screens.
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
          <p className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="text-[20px] font-semibold tracking-tight text-foreground truncate">
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
