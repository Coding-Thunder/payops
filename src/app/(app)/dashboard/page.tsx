import Link from "next/link";
import { ArrowRightIcon, PlusIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { OrderTable } from "@/components/features/orders/order-table";
import { PageHeader } from "@/components/common/page-header";
import { Permission, roleHasPermission } from "@/lib/constants/permissions";
import { OrderStatus, RecordState } from "@/lib/constants/enums";
import { formatCurrency } from "@/lib/format";
import { requireUser } from "@/server/auth/session";
import { listOrders } from "@/server/services/order.service";
import { getAnalyticsSummary } from "@/server/services/analytics.service";

export const metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await requireUser();
  const canSeeAll = roleHasPermission(user.role, Permission.ORDER_VIEW_ALL);
  const canSeeAnalytics = roleHasPermission(user.role, Permission.ANALYTICS_VIEW);

  const [recent, analytics] = await Promise.all([
    listOrders(
      {
        state: RecordState.ACTIVE,
        page: 1,
        pageSize: 5,
        mine: !canSeeAll ? true : undefined,
      },
      { actor: user },
    ),
    canSeeAnalytics
      ? getAnalyticsSummary({
          from: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        })
      : null,
  ]);

  return (
    <div className="space-y-8">
      <PageHeader
        title={`Welcome back, ${user.name.split(" ")[0]}`}
        description="Create payable orders and track every Stripe payment in one place."
        actions={
          <Button asChild>
            <Link href="/orders/create">
              <PlusIcon className="size-4" />
              New order
            </Link>
          </Button>
        }
      />

      {canSeeAnalytics && analytics ? (
        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Revenue (30 days)"
            value={formatCurrency(analytics.totals.revenue, analytics.totals.currency)}
            sub={`${analytics.totals.ordersPaid} paid orders`}
          />
          <Stat
            label="Conversion"
            value={`${analytics.totals.conversionRate}%`}
            sub={`${analytics.totals.ordersCreated} created`}
          />
          <Stat
            label="Pending"
            value={String(analytics.totals.ordersPending)}
            sub="Awaiting customer payment"
            tone="warning"
          />
          <Stat
            label="Failed or expired"
            value={String(
              analytics.totals.ordersFailed + analytics.totals.ordersExpired,
            )}
            sub="Last 30 days"
            tone="destructive"
          />
        </section>
      ) : null}

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold tracking-tight">
            {canSeeAll ? "Recent orders" : "Your recent orders"}
          </h2>
          <Button asChild variant="ghost" size="sm">
            <Link href="/orders">
              View all
              <ArrowRightIcon className="size-3.5" />
            </Link>
          </Button>
        </div>
        <OrderTable
          items={recent.items}
          emptyAction={
            <Button asChild>
              <Link href="/orders/create">
                <PlusIcon className="size-4" />
                Create your first order
              </Link>
            </Button>
          }
        />
      </section>

      {recent.items.some((o) => o.status === OrderStatus.PAYMENT_PENDING) ? (
        <Card>
          <CardHeader>
            <CardTitle>Outstanding payments</CardTitle>
            <CardDescription>
              These customers still need to complete payment. Use the order
              detail page to copy the payment link and resend it.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="text-sm space-y-2">
              {recent.items
                .filter((o) => o.status === OrderStatus.PAYMENT_PENDING)
                .map((o) => (
                  <li key={o.id} className="flex items-center justify-between">
                    <Link
                      href={`/orders/${o.id}`}
                      className="hover:underline"
                    >
                      <span className="font-mono text-xs">
                        {o.orderNumber}
                      </span>{" "}
                      • {o.customer.name}
                    </Link>
                    <span className="text-muted-foreground">
                      {formatCurrency(o.pricing.amount, o.pricing.currency)}
                    </span>
                  </li>
                ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "warning" | "destructive";
}) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-xs uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
        <p
          className={
            tone === "warning"
              ? "mt-1 text-2xl font-semibold tracking-tight text-amber-600 dark:text-amber-400"
              : tone === "destructive"
                ? "mt-1 text-2xl font-semibold tracking-tight text-destructive"
                : "mt-1 text-2xl font-semibold tracking-tight"
          }
        >
          {value}
        </p>
        {sub ? (
          <p className="mt-1 text-xs text-muted-foreground">{sub}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
