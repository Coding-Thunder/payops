import Link from "next/link";
import { ArrowRightIcon, SearchIcon } from "lucide-react";

import { ActivityFeed } from "@/components/features/activity/activity-feed";
import { DashboardSearch } from "@/components/features/dashboard/dashboard-search";
import { NewClientDialog } from "@/components/features/clients/new-client-dialog";
import { OrderStatusBadge } from "@/components/common/status-badges";
import { FadeIn } from "@/components/motion/fade-in";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { initialsFromName } from "@/lib/format";
import { cn } from "@/lib/utils";
import { requireUser } from "@/server/auth/session";
import {
  getDashboardData,
  type DashboardData,
} from "@/server/services/dashboard.service";

export const metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await requireUser();

  const data: DashboardData | null = user.orgId
    ? await getDashboardData(user.orgId)
    : null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-[26px] font-semibold tracking-tight text-foreground">
            Dashboard
          </h1>
          <p className="mt-1 text-[13.5px] text-muted-foreground">
            Find everything that has ever happened with a client.
          </p>
        </div>
        <NewClientDialog />
      </div>

      {/* Global search */}
      <DashboardSearch />

      {!data || !data.hasAnyClients ? (
        <EmptyDashboard />
      ) : (
        <PopulatedDashboard data={data} />
      )}
    </div>
  );
}

/* ── Populated ───────────────────────────────────────────────────────── */

function PopulatedDashboard({ data }: { data: DashboardData }) {
  const { counts, recentClients, needsAttention } = data;

  return (
    <>
      <FadeIn>
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <StatCard
            label="Client records"
            value={counts.clientRecords}
            caption="Total records"
            dot="success"
          />
          <StatCard
            label="Active clients"
            value={counts.activeClients}
            caption="Last 30 days"
            dot="success"
          />
          <StatCard
            label="Pending payments"
            value={counts.pendingPayments}
            caption="Awaiting collection"
            dot={counts.pendingPayments > 0 ? "warning" : "success"}
          />
          <StatCard
            label="Pending consents"
            value={counts.pendingConsents}
            caption="Consent not received"
            dot={counts.pendingConsents > 0 ? "warning" : "success"}
          />
          <StatCard
            label="Flagged records"
            value={counts.flaggedRecords}
            caption="Needs review"
            dot={counts.flaggedRecords > 0 ? "destructive" : "success"}
          />
          <StatCard
            label="Disputes"
            value={counts.disputes}
            caption="Open disputes"
            dot={counts.disputes > 0 ? "destructive" : "success"}
          />
        </section>
      </FadeIn>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        {/* Recent Client Records */}
        <FadeIn delay={60}>
          <Card className="overflow-hidden p-0">
            <div className="flex items-center justify-between px-5 pt-4">
              <CardTitle className="text-[14px]">Recent Client Records</CardTitle>
              <Button asChild variant="ghost" size="sm">
                <Link href="/app/customers">
                  View all
                  <ArrowRightIcon className="size-3" />
                </Link>
              </Button>
            </div>
            <CardContent className="p-0 pt-3">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Client</TableHead>
                    <TableHead className="hidden md:table-cell">
                      Company
                    </TableHead>
                    <TableHead className="hidden sm:table-cell">
                      Latest order
                    </TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentClients.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell>
                        <Link
                          href={`/app/customers/${c.id}`}
                          className="flex items-center gap-3"
                        >
                          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-surface-2 text-[11px] font-semibold text-muted-foreground">
                            {initialsFromName(c.name || c.email)}
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate font-medium text-foreground">
                              {c.name}
                            </span>
                            <span className="block truncate text-[12px] text-muted-foreground">
                              {c.email || "—"}
                            </span>
                          </span>
                        </Link>
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-[13px] text-muted-foreground">
                        {c.company || "—"}
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        {c.latestOrder ? (
                          <Link
                            href={`/app/orders/${c.latestOrder.id}`}
                            className="block min-w-0"
                          >
                            <span className="block truncate font-mono text-[12px] font-medium text-foreground">
                              {c.latestOrder.orderNumber}
                            </span>
                            {c.latestOrder.title ? (
                              <span className="block truncate text-[12px] text-muted-foreground">
                                {c.latestOrder.title}
                              </span>
                            ) : null}
                          </Link>
                        ) : (
                          <span className="text-[12px] text-muted-foreground">
                            No orders yet
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        {c.latestOrder ? (
                          <div className="flex flex-col items-start gap-1">
                            <OrderStatusBadge status={c.latestOrder.status} />
                            {c.latestOrder.consentPending ? (
                              <Badge variant="warning">Awaiting consent</Badge>
                            ) : null}
                          </div>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button asChild variant="outline" size="sm">
                          <Link href={`/app/customers/${c.id}`}>Open record</Link>
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </FadeIn>

        {/* Right rail: Recent Activity + Needs Attention */}
        <aside className="space-y-6">
          <FadeIn delay={120}>
            <ActivityFeed />
          </FadeIn>

          <FadeIn delay={180}>
            <Card>
              <CardHeader>
                <CardTitle className="text-[14px]">Needs attention</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {needsAttention.length === 0 ? (
                  <p className="px-5 pb-5 text-[13px] text-muted-foreground">
                    Nothing needs your attention right now.
                  </p>
                ) : (
                  <ul className="divide-y divide-border">
                    {needsAttention.map((item) => (
                      <li key={item.id} className="px-5 py-3">
                        <p className="text-[13px] font-medium text-foreground">
                          {item.title}
                        </p>
                        <p className="mt-0.5 text-[12px] text-muted-foreground">
                          {item.subtitle}
                        </p>
                        <Button
                          asChild
                          variant="outline"
                          size="sm"
                          className="mt-2"
                        >
                          <Link href={item.href}>{item.actionLabel}</Link>
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </FadeIn>
        </aside>
      </div>
    </>
  );
}

/* ── Empty state ─────────────────────────────────────────────────────── */

function EmptyDashboard() {
  return (
    <FadeIn>
      <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border bg-card/40 px-6 py-20 text-center">
        <span className="grid size-12 place-items-center rounded-full bg-muted text-muted-foreground">
          <SearchIcon className="size-5" />
        </span>
        <div className="space-y-1.5">
          <h2 className="text-[17px] font-semibold text-foreground">
            Create your first Client Record
          </h2>
          <p className="mx-auto max-w-md text-[13.5px] leading-relaxed text-muted-foreground">
            Every order, invoice, payment, consent, and file becomes part of one
            permanent client history. Nothing gets lost.
          </p>
        </div>
        <NewClientDialog
          trigger={
            <Button size="lg" className="gap-1.5">
              Create Client Record
            </Button>
          }
        />
      </div>
    </FadeIn>
  );
}

/* ── Stat card ───────────────────────────────────────────────────────── */

const DOT: Record<"success" | "warning" | "destructive", string> = {
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
};

function StatCard({
  label,
  value,
  caption,
  dot,
}: {
  label: string;
  value: number;
  caption: string;
  dot: "success" | "warning" | "destructive";
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-start justify-between">
        <p className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
        <span className={cn("mt-1 size-1.5 shrink-0 rounded-full", DOT[dot])} />
      </div>
      <p className="mt-2 text-[26px] font-semibold leading-none tracking-tight tabular-nums text-foreground">
        {value.toLocaleString("en-US")}
      </p>
      <p className="mt-1.5 text-[11.5px] text-muted-foreground">{caption}</p>
    </div>
  );
}
