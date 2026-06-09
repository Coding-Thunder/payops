import * as React from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/* ---------------------------------------------------------------------- */
/* Page header                                                            */
/* ---------------------------------------------------------------------- */

interface PageHeaderSkeletonProps {
  /** Width of the title bar. */
  titleWidth?: string;
  withEyebrow?: boolean;
  withDescription?: boolean;
  withActions?: boolean;
  className?: string;
}

export function PageHeaderSkeleton({
  titleWidth = "14rem",
  withEyebrow = false,
  withDescription = true,
  withActions = false,
  className,
}: PageHeaderSkeletonProps) {
  return (
    <header
      className={cn(
        "flex flex-col gap-3 pb-5 border-b border-border sm:flex-row sm:items-end sm:justify-between",
        className,
      )}
      aria-busy
    >
      <div className="space-y-2 min-w-0">
        {withEyebrow ? <Skeleton className="h-3 w-16" /> : null}
        <Skeleton className="h-5" style={{ width: titleWidth }} />
        {withDescription ? <Skeleton className="h-3.5 w-72 max-w-full" /> : null}
      </div>
      {withActions ? (
        <div className="flex flex-wrap gap-2">
          <Skeleton className="h-8 w-28 rounded-md" />
        </div>
      ) : null}
    </header>
  );
}

/* ---------------------------------------------------------------------- */
/* Stat / metric cards                                                    */
/* ---------------------------------------------------------------------- */

export function MetricSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-lg border border-border bg-card px-4 py-3.5",
        className,
      )}
      aria-busy
    >
      <Skeleton className="h-3 w-20" />
      <Skeleton className="h-6 w-24" />
      <Skeleton className="h-3 w-28" />
    </div>
  );
}

interface MetricGridSkeletonProps {
  count?: number;
  className?: string;
}

export function MetricGridSkeleton({
  count = 4,
  className,
}: MetricGridSkeletonProps) {
  return (
    <section
      className={cn("grid gap-3 sm:grid-cols-2 lg:grid-cols-4", className)}
      aria-busy
    >
      {Array.from({ length: count }).map((_, i) => (
        <MetricSkeleton key={i} />
      ))}
    </section>
  );
}

/* ---------------------------------------------------------------------- */
/* Table                                                                  */
/* ---------------------------------------------------------------------- */

interface TableSkeletonProps {
  /** Number of placeholder rows. */
  rows?: number;
  /** Column count drives both header and row cell counts. */
  columns?: number;
  /**
   * Per-column width hints. Falls back to a balanced distribution if not
   * provided. Pass any valid CSS width.
   */
  columnWidths?: (string | number)[];
  /** Optional toolbar bar above the table. */
  withToolbar?: boolean;
  className?: string;
}

export function TableSkeleton({
  rows = 6,
  columns = 6,
  columnWidths,
  withToolbar = false,
  className,
}: TableSkeletonProps) {
  const widths =
    columnWidths ??
    Array.from({ length: columns }).map((_, i) =>
      i === 0 ? "9rem" : i === columns - 1 ? "3rem" : undefined,
    );

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-border bg-card",
        className,
      )}
      aria-busy
    >
      {withToolbar ? (
        <div className="flex items-center justify-between border-b border-border bg-surface-1 px-4 py-2">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-6 w-20" />
        </div>
      ) : null}

      <div className="border-b border-border bg-surface-1/60 px-4 py-2.5">
        <div
          className="grid items-center gap-4"
          style={{
            gridTemplateColumns: widths
              .map((w) => (w ? (typeof w === "number" ? `${w}px` : w) : "1fr"))
              .join(" "),
          }}
        >
          {widths.map((_, i) => (
            <Skeleton key={i} className="h-3 w-16 max-w-full" />
          ))}
        </div>
      </div>
      <div className="divide-y divide-border">
        {Array.from({ length: rows }).map((_, r) => (
          <div key={r} className="px-4 py-3">
            <div
              className="grid items-center gap-4"
              style={{
                gridTemplateColumns: widths
                  .map((w) =>
                    w ? (typeof w === "number" ? `${w}px` : w) : "1fr",
                  )
                  .join(" "),
              }}
            >
              {widths.map((_, c) => (
                <div key={c} className="space-y-1.5">
                  <Skeleton
                    className={cn(
                      "h-3.5",
                      c === 0 ? "w-24" : c === widths.length - 1 ? "w-6" : "w-full max-w-[10rem]",
                    )}
                  />
                  {c === 1 ? <Skeleton className="h-3 w-16" /> : null}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Card / list block                                                      */
/* ---------------------------------------------------------------------- */

interface CardSkeletonProps {
  className?: string;
  withHeader?: boolean;
  lines?: number;
  /** Adds a trailing button-shaped block in the header. */
  withHeaderAction?: boolean;
}

export function CardSkeleton({
  className,
  withHeader = true,
  lines = 3,
  withHeaderAction = false,
}: CardSkeletonProps) {
  return (
    <Card className={className} aria-busy>
      {withHeader ? (
        <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
          <div className="space-y-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-48" />
          </div>
          {withHeaderAction ? (
            <Skeleton className="h-6 w-16 rounded-md" />
          ) : null}
        </CardHeader>
      ) : null}
      <CardContent className="space-y-3">
        {Array.from({ length: lines }).map((_, i) => (
          <Skeleton
            key={i}
            className={cn(
              "h-3.5",
              i === lines - 1 ? "w-2/3" : i % 2 === 0 ? "w-full" : "w-5/6",
            )}
          />
        ))}
      </CardContent>
    </Card>
  );
}

/* ---------------------------------------------------------------------- */
/* Form                                                                   */
/* ---------------------------------------------------------------------- */

interface FormSkeletonProps {
  /** How many "field group" rows to render. Each row has two fields. */
  rows?: number;
  /** How many sections (each section = its own Card-like block). */
  sections?: number;
  /** Show a trailing actions row with two buttons. */
  withFooter?: boolean;
  className?: string;
}

export function FormSkeleton({
  rows = 3,
  sections = 1,
  withFooter = true,
  className,
}: FormSkeletonProps) {
  return (
    <div className={cn("space-y-6", className)} aria-busy>
      {Array.from({ length: sections }).map((_, s) => (
        <Card key={s}>
          <CardHeader>
            <Skeleton className="h-4 w-32" />
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            {Array.from({ length: rows * 2 }).map((_, i) => (
              <div key={i} className="space-y-1.5">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-9 w-full rounded-md" />
              </div>
            ))}
          </CardContent>
        </Card>
      ))}
      {withFooter ? (
        <div className="flex justify-end gap-2">
          <Skeleton className="h-8 w-20 rounded-md" />
          <Skeleton className="h-8 w-32 rounded-md" />
        </div>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Activity / list feeds                                                  */
/* ---------------------------------------------------------------------- */

export function ActivityFeedSkeleton({
  rows = 5,
  className,
}: {
  rows?: number;
  className?: string;
}) {
  return (
    <Card className={className} aria-busy>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div className="space-y-2">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-3 w-44" />
        </div>
        <Skeleton className="h-3 w-12" />
      </CardHeader>
      <CardContent>
        <ol className="space-y-3">
          {Array.from({ length: rows }).map((_, i) => (
            <li key={i} className="flex items-start gap-3 px-2 py-2">
              <Skeleton className="size-7 rounded-md" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3.5 w-32" />
                <Skeleton className="h-3 w-48 max-w-full" />
              </div>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

/* ---------------------------------------------------------------------- */
/* Provider card grid                                                     */
/* ---------------------------------------------------------------------- */

export function ProviderCardSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg border border-border bg-card p-3",
        className,
      )}
      aria-busy
    >
      <Skeleton className="size-10 rounded-md" />
      <div className="flex-1 space-y-1.5">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3 w-24" />
      </div>
      <Skeleton className="h-6 w-16 rounded-md" />
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Order details split view                                               */
/* ---------------------------------------------------------------------- */

export function OrderDetailsSkeleton() {
  return (
    <div className="space-y-6" aria-busy>
      <Skeleton className="h-7 w-24 rounded-md" />
      <PageHeaderSkeleton withActions titleWidth="11rem" />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          <CardSkeleton lines={6} withHeaderAction />
        </div>
        <div className="space-y-6">
          <CardSkeleton lines={4} withHeaderAction />
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Page-level scaffolds                                                   */
/* ---------------------------------------------------------------------- */

interface PageSkeletonProps {
  /** Render a metric grid below the page header. */
  metrics?: number;
  /** Render a table beneath. */
  withTable?: boolean;
  /** Table row/column hints. */
  tableRows?: number;
  tableColumns?: number;
  /** Show a tall chart-shaped block. */
  withChart?: boolean;
  /** Header configuration. */
  header?: PageHeaderSkeletonProps;
  className?: string;
}

export function PageSkeleton({
  metrics,
  withTable,
  tableRows,
  tableColumns,
  withChart,
  header,
  className,
}: PageSkeletonProps) {
  return (
    <div className={cn("space-y-6", className)} aria-busy>
      <PageHeaderSkeleton {...header} />
      {metrics ? <MetricGridSkeleton count={metrics} /> : null}
      {withChart ? (
        <Card>
          <CardHeader>
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-3 w-48" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-56 w-full rounded-md" />
          </CardContent>
        </Card>
      ) : null}
      {withTable ? (
        <TableSkeleton rows={tableRows ?? 6} columns={tableColumns ?? 6} />
      ) : null}
    </div>
  );
}
