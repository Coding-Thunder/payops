import Link from "next/link";
import { AlertOctagonIcon, ClockIcon, ShieldAlertIcon } from "lucide-react";

import { EmptyState } from "@/components/common/empty-state";
import { OrderStatus } from "@/lib/constants/enums";
import { formatRelative } from "@/lib/format";
import type { OrderDTO } from "@/types";

/**
 * Compact list of the latest at-risk orders for the dashboard rail.
 *
 * Five rows max. Each row is a single tight line: order number ·
 * customer name · reason · time. No card chrome per row, no badges
 * competing for attention, the icon is the only visual marker.
 */

interface RecentDisputesProps {
  orders: OrderDTO[];
}

export function RecentDisputes({ orders }: RecentDisputesProps) {
  const items = orders.slice(0, 5);

  return (
    <section className="rounded-lg border border-border bg-card">
      <header className="flex items-baseline justify-between border-b border-border px-4 py-3">
        <h3 className="text-[12.5px] font-semibold tracking-tight">
          Recent at-risk orders
        </h3>
        {orders.length > 5 ? (
          <Link
            href="/app/admin/disputes"
            className="text-[11.5px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            +{orders.length - 5} more
          </Link>
        ) : null}
      </header>

      {items.length === 0 ? (
        <div className="p-4">
          <EmptyState
            title="Nothing to review"
            description="No flagged, failed, or expired orders right now."
          />
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((o) => (
            <RecentRow key={o.id} order={o} />
          ))}
        </ul>
      )}
    </section>
  );
}

function RecentRow({ order }: { order: OrderDTO }) {
  return (
    <li>
      <Link
        href={`/app/orders/${order.id}`}
        className="grid grid-cols-[1rem_1fr_auto] items-center gap-2.5 px-4 py-2.5 transition-colors hover:bg-muted/50"
      >
        <ReasonIcon order={order} />
        <div className="min-w-0">
          <p className="truncate text-[12.5px] font-medium leading-tight">
            {order.customer.name}
          </p>
          <p className="mt-0.5 truncate font-mono text-[10.5px] text-muted-foreground leading-tight tabular-nums">
            {order.orderNumber} · {reasonLabel(order)}
          </p>
        </div>
        <span className="font-mono text-[10.5px] text-muted-foreground tabular-nums whitespace-nowrap">
          {formatRelative(order.updatedAt)}
        </span>
      </Link>
    </li>
  );
}

function ReasonIcon({ order }: { order: OrderDTO }) {
  if (order.risk.flagged) {
    return (
      <ShieldAlertIcon
        className="size-3.5 text-destructive"
        aria-label="Flagged"
      />
    );
  }
  if (order.status === OrderStatus.FAILED) {
    return (
      <AlertOctagonIcon
        className="size-3.5 text-destructive"
        aria-label="Payment failed"
      />
    );
  }
  return (
    <ClockIcon
      className="size-3.5 text-warning-foreground"
      aria-label="Expired"
    />
  );
}

function reasonLabel(order: OrderDTO): string {
  if (order.risk.flagged) return "Flagged";
  if (order.status === OrderStatus.FAILED) return "Payment failed";
  if (order.status === OrderStatus.EXPIRED) return "Link expired";
  return "At risk";
}
