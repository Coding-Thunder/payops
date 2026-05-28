import Link from "next/link";
import { ArrowRightIcon } from "lucide-react";

import { OrderStatus } from "@/lib/constants/enums";
import type { OrderDTO } from "@/types";

/**
 * Compact dispute-health panel for the dashboard right rail.
 *
 * Reads the live at-risk list (the same data backing /admin/disputes)
 * and surfaces three numeric facts: how many orders need an operator
 * right now, how many were manually flagged, and how many failed or
 * expired in the active window.
 *
 * Deliberately not a chart. The dashboard is the operator's daily
 * surface — these are the counts that decide whether they need to
 * click into Disputes today, not a 30-day overview.
 */

interface DisputeHealthProps {
  atRisk: OrderDTO[];
}

export function DisputeHealth({ atRisk }: DisputeHealthProps) {
  const flagged = atRisk.filter((o) => o.risk.flagged).length;
  const failed = atRisk.filter((o) => o.status === OrderStatus.FAILED).length;
  const expired = atRisk.filter(
    (o) => o.status === OrderStatus.EXPIRED,
  ).length;

  return (
    <section className="rounded-lg border border-border bg-card">
      <header className="flex items-baseline justify-between border-b border-border px-4 py-3">
        <div>
          <h3 className="text-[12.5px] font-semibold tracking-tight">
            Dispute health
          </h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Orders an operator should look at today.
          </p>
        </div>
        <Link
          href="/app/admin/disputes"
          className="inline-flex items-center gap-1 text-[11.5px] font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          View all
          <ArrowRightIcon className="size-3" />
        </Link>
      </header>

      <dl className="grid grid-cols-3 divide-x divide-border">
        <Stat
          label="At risk"
          value={atRisk.length}
          tone={atRisk.length > 0 ? "warning" : "neutral"}
        />
        <Stat
          label="Flagged"
          value={flagged}
          tone={flagged > 0 ? "danger" : "neutral"}
        />
        <Stat
          label="Failed · Expired"
          value={failed + expired}
          tone="neutral"
        />
      </dl>
    </section>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "neutral" | "warning" | "danger";
}) {
  const accent =
    tone === "warning"
      ? "var(--warning)"
      : tone === "danger"
        ? "var(--destructive)"
        : "var(--success)";
  const number =
    tone === "warning"
      ? "text-warning-foreground"
      : tone === "danger"
        ? "text-destructive"
        : "text-foreground";
  return (
    <div className="relative px-4 py-3.5">
      <span
        aria-hidden
        className="absolute inset-x-3 top-0 h-[2px] rounded-full"
        style={{ background: accent }}
      />
      <dt className="text-[10.5px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </dt>
      <dd
        className={`mt-1.5 font-mono text-[22px] font-semibold leading-none tabular-nums ${number}`}
      >
        {value}
      </dd>
    </div>
  );
}
