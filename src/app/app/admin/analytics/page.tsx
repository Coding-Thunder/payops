import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { PageHeader } from "@/components/common/page-header";
import { StatCard } from "@/components/common/stat-card";
import { RevenueChart } from "@/components/features/analytics/revenue-chart";
import { Permission } from "@/lib/constants/permissions";
import { formatCurrency, formatDate } from "@/lib/format";
import { requirePermission } from "@/server/auth/session";
import { getAnalyticsSummary } from "@/server/services/analytics.service";

export const metadata = { title: "Analytics" };
export const dynamic = "force-dynamic";

export default async function AdminAnalyticsPage() {
  const user = await requirePermission(Permission.ANALYTICS_VIEW);
  // Pass orgId so analytics is tenant-scoped + the per-item-type
  // breakdown can join against THIS tenant's ItemType catalog to
  // resolve display names.
  const summary = await getAnalyticsSummary({}, { orgId: user.orgId });

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Admin"
        title="Analytics"
        description={`Range · ${formatDate(summary.range.from)} → ${formatDate(summary.range.to)} (30 days)`}
      />

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Revenue"
          value={formatCurrency(
            summary.totals.revenue,
            summary.totals.currency,
          )}
          caption={`${summary.totals.ordersPaid} paid`}
        />
        <StatCard
          label="Average order"
          value={formatCurrency(
            summary.totals.averageOrderValue,
            summary.totals.currency,
          )}
          caption="Across paid orders"
        />
        <StatCard
          label="Conversion"
          value={`${summary.totals.conversionRate}%`}
          caption={`${summary.totals.ordersCreated} total`}
        />
        <StatCard
          label="Outstanding"
          value={summary.totals.ordersPending}
          caption={`${summary.totals.ordersFailed + summary.totals.ordersExpired} failed/expired`}
          variant="warning"
        />
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Daily revenue</CardTitle>
          <CardDescription>
            Sum of confirmed payments per calendar day.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RevenueChart
            data={summary.daily}
            currency={summary.totals.currency}
          />
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>By item type</CardTitle>
          </CardHeader>
          <CardContent>
            {summary.itemTypes.length === 0 ? (
              <p className="text-[12.5px] text-muted-foreground">
                No data yet.
              </p>
            ) : (
              <ul className="divide-y divide-border text-[13px]">
                {summary.itemTypes.map((b) => (
                  <li
                    key={b.itemTypeKey}
                    className="flex items-center justify-between py-2"
                  >
                    <span className="text-foreground text-[13px]">
                      {b.displayName}
                    </span>
                    <span className="text-muted-foreground tabular-nums">
                      {b.count} orders ·{" "}
                      <span className="text-foreground font-medium">
                        {formatCurrency(b.revenue, summary.totals.currency)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Top staff</CardTitle>
            <CardDescription>By revenue collected.</CardDescription>
          </CardHeader>
          <CardContent>
            {summary.topStaff.length === 0 ? (
              <p className="text-[12.5px] text-muted-foreground">
                No data yet.
              </p>
            ) : (
              <ul className="divide-y divide-border text-[13px]">
                {summary.topStaff.map((s) => (
                  <li
                    key={s.userId}
                    className="flex items-center justify-between py-2"
                  >
                    <span className="text-foreground">{s.name}</span>
                    <span className="text-muted-foreground tabular-nums">
                      {s.orders} orders ·{" "}
                      <span className="text-foreground font-medium">
                        {formatCurrency(s.revenue, summary.totals.currency)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
