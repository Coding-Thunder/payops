import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { PageHeader } from "@/components/common/page-header";
import { RevenueChart } from "@/components/features/analytics/revenue-chart";
import { BookingTypeLabel } from "@/lib/constants/labels";
import { Permission } from "@/lib/constants/permissions";
import { formatCurrency, formatDate } from "@/lib/format";
import { requirePermission } from "@/server/auth/session";
import { getAnalyticsSummary } from "@/server/services/analytics.service";

export const metadata = { title: "Analytics" };
export const dynamic = "force-dynamic";

export default async function AdminAnalyticsPage() {
  await requirePermission(Permission.ANALYTICS_VIEW);
  const summary = await getAnalyticsSummary({
    from: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Analytics"
        description={`Range: ${formatDate(summary.range.from)} → ${formatDate(summary.range.to)} (30 days)`}
      />

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Revenue"
          value={formatCurrency(
            summary.totals.revenue,
            summary.totals.currency,
          )}
          sub={`${summary.totals.ordersPaid} paid`}
        />
        <Stat
          label="Avg order value"
          value={formatCurrency(
            summary.totals.averageOrderValue,
            summary.totals.currency,
          )}
          sub="Across paid orders"
        />
        <Stat
          label="Conversion"
          value={`${summary.totals.conversionRate}%`}
          sub={`${summary.totals.ordersCreated} total orders`}
        />
        <Stat
          label="Pending"
          value={String(summary.totals.ordersPending)}
          sub={`${summary.totals.ordersFailed + summary.totals.ordersExpired} failed/expired`}
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

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>By booking type</CardTitle>
          </CardHeader>
          <CardContent>
            {summary.bookingTypes.length === 0 ? (
              <p className="text-sm text-muted-foreground">No data yet.</p>
            ) : (
              <ul className="space-y-3">
                {summary.bookingTypes.map((b) => (
                  <li
                    key={b.bookingType}
                    className="flex items-center justify-between text-sm"
                  >
                    <span>{BookingTypeLabel[b.bookingType]}</span>
                    <span className="text-muted-foreground">
                      {b.count} orders •{" "}
                      {formatCurrency(b.revenue, summary.totals.currency)}
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
              <p className="text-sm text-muted-foreground">No data yet.</p>
            ) : (
              <ul className="space-y-3">
                {summary.topStaff.map((s) => (
                  <li
                    key={s.userId}
                    className="flex items-center justify-between text-sm"
                  >
                    <span>{s.name}</span>
                    <span className="text-muted-foreground">
                      {s.orders} orders •{" "}
                      {formatCurrency(s.revenue, summary.totals.currency)}
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

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-xs uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
        <p className="mt-1 text-2xl font-semibold tracking-tight">{value}</p>
        {sub ? (
          <p className="mt-1 text-xs text-muted-foreground">{sub}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
