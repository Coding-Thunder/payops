import Link from "next/link";
import { ArrowRightIcon, PlusIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ActivityFeed } from "@/components/features/activity/activity-feed";
import { DisputeHealth } from "@/components/features/dashboard/dispute-health";
import { RecentDisputes } from "@/components/features/dashboard/recent-disputes";
import { OrderTable } from "@/components/features/orders/order-table";
import { SetupChecklist } from "@/components/features/onboarding/setup-checklist";
import { FadeIn } from "@/components/motion/fade-in";
import { PageHeader } from "@/components/common/page-header";
import { StatCard } from "@/components/common/stat-card";
import { Permission, roleHasPermission } from "@/lib/constants/permissions";
import { OrderStatus, RecordState } from "@/lib/constants/enums";
import { formatCurrency } from "@/lib/format";
import { requireUser } from "@/server/auth/session";
import { listAtRiskOrders, listOrders } from "@/server/services/order.service";
import { getAnalyticsSummary } from "@/server/services/analytics.service";
import { getOnboardingState } from "@/server/services/onboarding-state.service";

export const metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;

export default async function DashboardPage() {
  const user = await requireUser();
  const canSeeAll = roleHasPermission(user.role, Permission.ORDER_VIEW_ALL);
  const canSeeAnalytics = roleHasPermission(user.role, Permission.ANALYTICS_VIEW);

  const now = new Date();
  const thirtyAgo = new Date(now.getTime() - 30 * DAY_MS);
  const sixtyAgo = new Date(now.getTime() - 60 * DAY_MS);

  const [recent, analytics, priorAnalytics, atRisk, onboarding] =
    await Promise.all([
      listOrders(
        {
          state: RecordState.ACTIVE,
          page: 1,
          pageSize: 5,
          mine: !canSeeAll ? true : undefined,
        },
        { actor: user, orgId: user.orgId },
      ),
      canSeeAnalytics
        ? getAnalyticsSummary({ from: thirtyAgo, to: now })
        : null,
      // Prior 30-day window — drives the trend deltas on the KPI row.
      canSeeAnalytics
        ? getAnalyticsSummary({ from: sixtyAgo, to: thirtyAgo })
        : null,
      canSeeAll ? listAtRiskOrders(user.orgId) : [],
      getOnboardingState(user.orgId),
    ]);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Workspace"
        title="Dashboard"
        description="Every order, every payment, every dispute — one operator surface."
        actions={
          <Button asChild>
            <Link href="/app/orders/create">
              <PlusIcon className="size-3.5" />
              New order
            </Link>
          </Button>
        }
      />

      {!onboarding.complete ? (
        <FadeIn>
          <SetupChecklist state={onboarding} />
        </FadeIn>
      ) : null}

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
              trend={revenueTrend(analytics, priorAnalytics)}
            />
            <StatCard
              label="Conversion"
              value={`${analytics.totals.conversionRate}%`}
              caption={`${analytics.totals.ordersCreated} created`}
              trend={pctPointTrend(
                analytics?.totals.conversionRate,
                priorAnalytics?.totals.conversionRate,
              )}
            />
            <StatCard
              label="Outstanding"
              value={analytics.totals.ordersPending}
              caption="Awaiting customer payment"
              variant={analytics.totals.ordersPending > 0 ? "warning" : "default"}
            />
            <StatCard
              label="Failed · Expired"
              value={
                analytics.totals.ordersFailed + analytics.totals.ordersExpired
              }
              caption="Last 30 days"
              variant="destructive"
            />
          </section>
        </FadeIn>
      ) : null}

      {/* Two-column body: main flow on the left, dispute + activity
          context on the right. Single column below `lg`. */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)] xl:gap-8">
        {/* ── Main column ───────────────────────────────────────── */}
        <section className="space-y-6">
          <FadeIn delay={60} className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-[13.5px] font-semibold tracking-tight">
                {canSeeAll ? "Recent orders" : "Your recent orders"}
              </h2>
              <Button asChild variant="ghost" size="sm">
                <Link href="/app/orders">
                  View all
                  <ArrowRightIcon className="size-3" />
                </Link>
              </Button>
            </div>
            <OrderTable
              items={recent.items}
              emptyAction={
                <Button asChild>
                  <Link href="/app/orders/create">
                    <PlusIcon className="size-3.5" />
                    Create your first order
                  </Link>
                </Button>
              }
            />
          </FadeIn>

          {recent.items.some((o) => o.status === OrderStatus.PAYMENT_PENDING) ? (
            <FadeIn delay={120}>
              <Card>
                <CardHeader>
                  <CardTitle className="text-[13.5px]">
                    Outstanding payments
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="divide-y divide-border text-[12.5px]">
                    {recent.items
                      .filter((o) => o.status === OrderStatus.PAYMENT_PENDING)
                      .map((o) => (
                        <li
                          key={o.id}
                          className="flex items-center justify-between gap-3 py-2"
                        >
                          <Link
                            href={`/app/orders/${o.id}`}
                            className="flex min-w-0 flex-1 items-center gap-3 text-muted-foreground transition-colors hover:text-foreground"
                          >
                            <span className="flex min-w-0 flex-col leading-tight">
                              <span className="truncate text-foreground">
                                {o.customer.name}
                              </span>
                              <span className="truncate font-mono text-[10.5px] tabular-nums">
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
        </section>

        {/* ── Right rail ────────────────────────────────────────── */}
        <aside className="space-y-4">
          {canSeeAll ? (
            <FadeIn delay={60}>
              <DisputeHealth atRisk={atRisk} />
            </FadeIn>
          ) : null}

          {canSeeAll ? (
            <FadeIn delay={120}>
              <RecentDisputes orders={atRisk} />
            </FadeIn>
          ) : null}

          <FadeIn delay={180}>
            <ActivityFeed />
          </FadeIn>
        </aside>
      </div>
    </div>
  );
}

/* ─────────── trend helpers ──────────────────────────────────────────── */

function revenueTrend(
  current: { totals: { revenue: number; currency: string } },
  prior: { totals: { revenue: number; currency: string } } | null,
): { direction: "up" | "down" | "flat"; label: string } | undefined {
  if (!prior) return undefined;
  const cur = current.totals.revenue;
  const pre = prior.totals.revenue;
  if (pre === 0 && cur === 0) return undefined;
  if (pre === 0) return { direction: "up", label: "new" };
  const pct = ((cur - pre) / pre) * 100;
  return {
    direction: pct > 0.5 ? "up" : pct < -0.5 ? "down" : "flat",
    label: `${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%`,
  };
}

function pctPointTrend(
  current?: number,
  prior?: number,
): { direction: "up" | "down" | "flat"; label: string } | undefined {
  if (current === undefined || prior === undefined) return undefined;
  if (current === prior) return undefined;
  const diff = current - prior;
  return {
    direction: diff > 0.5 ? "up" : diff < -0.5 ? "down" : "flat",
    label: `${diff >= 0 ? "+" : ""}${diff.toFixed(1)} pp`,
  };
}
