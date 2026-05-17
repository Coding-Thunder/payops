import Link from "next/link";
import { ArrowRightIcon, PlusIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ActivityFeed } from "@/components/features/activity/activity-feed";
import { OrderTable } from "@/components/features/orders/order-table";
import { ProviderBadge } from "@/components/features/providers";
import { Aurora } from "@/components/brand/aurora";
import { FadeIn } from "@/components/motion/fade-in";
import { PageHeader } from "@/components/common/page-header";
import { StatCard } from "@/components/common/stat-card";
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
    canSeeAnalytics ? getAnalyticsSummary() : null,
  ]);

  const firstName = user.name.split(" ")[0];

  return (
    <div className="space-y-8">
      <div className="relative overflow-hidden rounded-2xl border border-border bg-card">
        <Aurora />
        <div className="relative px-5 py-5 sm:px-8 sm:py-7">
          <PageHeader
            eyebrow="Workspace"
            title={`Welcome back, ${firstName}`}
            description="Create payable orders and track every Stripe payment in one place."
            className="border-0 pb-0"
            actions={
              <Button asChild>
                <Link href="/orders/create">
                  <PlusIcon className="size-3.5" />
                  New order
                </Link>
              </Button>
            }
          />
        </div>
      </div>

      {canSeeAnalytics && analytics ? (
        <FadeIn>
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="Revenue · 30d"
              value={formatCurrency(
                analytics.totals.revenue,
                analytics.totals.currency,
              )}
              caption={`${analytics.totals.ordersPaid} paid orders`}
            />
            <StatCard
              label="Conversion"
              value={`${analytics.totals.conversionRate}%`}
              caption={`${analytics.totals.ordersCreated} created`}
            />
            <StatCard
              label="Outstanding"
              value={analytics.totals.ordersPending}
              caption="Awaiting customer payment"
              variant="warning"
            />
            <StatCard
              label="Failed / expired"
              value={
                analytics.totals.ordersFailed + analytics.totals.ordersExpired
              }
              caption="Last 30 days"
              variant="destructive"
            />
          </section>
        </FadeIn>
      ) : null}

      {/* Stacked, full-width: keeps the orders table from forcing an
          inner horizontal scroll when squeezed into a 2/3 grid column. */}
      <FadeIn delay={60} className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-[14px] font-semibold tracking-tight">
            {canSeeAll ? "Recent orders" : "Your recent orders"}
          </h2>
          <Button asChild variant="ghost" size="sm">
            <Link href="/orders">
              View all
              <ArrowRightIcon className="size-3" />
            </Link>
          </Button>
        </div>
        <OrderTable
          items={recent.items}
          emptyAction={
            <Button asChild>
              <Link href="/orders/create">
                <PlusIcon className="size-3.5" />
                Create your first order
              </Link>
            </Button>
          }
        />
      </FadeIn>

      <FadeIn delay={120}>
        <ActivityFeed />
      </FadeIn>

      {recent.items.some((o) => o.status === OrderStatus.PAYMENT_PENDING) ? (
        <FadeIn delay={180}>
          <Card>
            <CardHeader>
              <CardTitle>Outstanding payments</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="divide-y divide-border text-[13px]">
                {recent.items
                  .filter((o) => o.status === OrderStatus.PAYMENT_PENDING)
                  .map((o) => (
                    <li
                      key={o.id}
                      className="flex items-center justify-between gap-3 py-2"
                    >
                      <Link
                        href={`/orders/${o.id}`}
                        className="flex min-w-0 flex-1 items-center gap-3 text-muted-foreground transition-colors hover:text-foreground"
                      >
                        <ProviderBadge
                          provider={o.provider}
                          showName={false}
                          size="sm"
                        />
                        <span className="flex min-w-0 flex-col leading-tight">
                          <span className="truncate text-[13px] text-foreground">
                            {o.customer.name}
                          </span>
                          <span className="truncate font-mono text-[11px]">
                            {o.orderNumber}
                          </span>
                        </span>
                      </Link>
                      <span className="font-medium text-foreground tabular-nums">
                        {formatCurrency(o.pricing.amount, o.pricing.currency)}
                      </span>
                    </li>
                  ))}
              </ul>
            </CardContent>
          </Card>
        </FadeIn>
      ) : null}
    </div>
  );
}
