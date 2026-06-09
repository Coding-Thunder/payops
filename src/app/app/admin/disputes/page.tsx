import Link from "next/link";
import {
  AlertOctagonIcon,
  ClockIcon,
  ShieldAlertIcon,
  XCircleIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
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
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/common/page-header";
import { StatCard } from "@/components/common/stat-card";
import { RiskFlagDialog } from "@/components/features/disputes/risk-flag-dialog";
import { EvidenceSearchForm } from "@/components/features/evidence/evidence-search-form";
import { OrderStatusBadge } from "@/components/common/status-badges";
import { OrderStatus } from "@/lib/constants/enums";
import { Permission, roleHasPermission } from "@/lib/constants/permissions";
import { formatCurrency, formatDateTime, formatRelative } from "@/lib/format";
import { requirePermission } from "@/server/auth/session";
import { listAtRiskOrders } from "@/server/services/order.service";
import type { OrderDTO } from "@/types";

export const metadata = { title: "Disputes" };
export const dynamic = "force-dynamic";

interface RiskReason {
  label: string;
  tone: "destructive" | "warning" | "info";
}

function reasonsFor(order: OrderDTO): RiskReason[] {
  const out: RiskReason[] = [];
  if (order.risk.flagged) {
    out.push({ label: "Manually flagged", tone: "destructive" });
  }
  if (order.status === OrderStatus.FAILED) {
    out.push({ label: "Stripe payment failed", tone: "destructive" });
  }
  if (order.status === OrderStatus.EXPIRED) {
    out.push({ label: "Checkout link expired", tone: "warning" });
  }
  return out;
}

export default async function DisputesPage() {
  const actor = await requirePermission(Permission.ORDER_VIEW_ALL);
  // Pass 5a: dispute board scoped to actor's tenant.
  const items = await listAtRiskOrders(actor.orgId);
  const canSearchEvidence = roleHasPermission(
    actor.role,
    Permission.EVIDENCE_VIEW,
  );

  const flagged = items.filter((o) => o.risk.flagged);
  const failed = items.filter((o) => o.status === OrderStatus.FAILED);
  const expired = items.filter((o) => o.status === OrderStatus.EXPIRED);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Admin"
        title="Disputes & at-risk orders"
        description="Orders that need an operator's attention, manually flagged, payment failed, or the checkout link expired. Resolving these promptly keeps your Stripe dispute rate low."
      />

      {canSearchEvidence ? <EvidenceSearchForm /> : null}

      <section className="grid gap-3 sm:grid-cols-3">
        <StatCard
          label="Manually flagged"
          value={flagged.length}
          caption="Operator-reviewed"
          variant={flagged.length > 0 ? "destructive" : "default"}
        />
        <StatCard
          label="Payment failed"
          value={failed.length}
          caption="Stripe rejected the charge"
          variant={failed.length > 0 ? "warning" : "default"}
        />
        <StatCard
          label="Expired links"
          value={expired.length}
          caption="Customer never paid in time"
        />
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Watchlist</CardTitle>
          <CardDescription>
            Flagged orders sit at the top, clear the flag once the situation
            is resolved. Showing up to 100 most recent.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {items.length === 0 ? (
            <div className="p-6">
              <EmptyState
                title="Nothing to review"
                description="No flagged, failed, or expired orders. Stripe disputes will only show up here once you mark them with the risk flag from the order detail page."
              />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[180px]">Order</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Reasons</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden md:table-cell">
                    Last update
                  </TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((o) => {
                  const reasons = reasonsFor(o);
                  return (
                    <TableRow key={o.id}>
                      <TableCell>
                        <Link
                          href={`/app/orders/${o.id}`}
                          className="font-mono text-[12px] font-medium text-foreground hover:underline"
                        >
                          {o.orderNumber}
                        </Link>
                        {o.risk.flagged && o.risk.flaggedNote ? (
                          <div className="mt-1 text-[11px] text-muted-foreground line-clamp-2">
                            “{o.risk.flaggedNote}”
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <div className="text-[13px] font-medium leading-tight">
                          {o.customer.name}
                        </div>
                        <div className="mt-0.5 text-[11.5px] text-muted-foreground leading-tight">
                          {o.customer.email}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {reasons.map((r) => (
                            <Badge key={r.label} variant={r.tone}>
                              {r.tone === "destructive" ? (
                                <AlertOctagonIcon className="size-3" />
                              ) : r.tone === "warning" ? (
                                <ClockIcon className="size-3" />
                              ) : (
                                <ShieldAlertIcon className="size-3" />
                              )}
                              {r.label}
                            </Badge>
                          ))}
                        </div>
                        {o.payment.failureReason ? (
                          <p className="mt-1 text-[11px] text-muted-foreground line-clamp-1">
                            {o.payment.failureReason}
                          </p>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right font-medium tabular-nums">
                        {formatCurrency(o.pricing.amount, o.pricing.currency)}
                      </TableCell>
                      <TableCell>
                        <OrderStatusBadge status={o.status} />
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-[11.5px] text-muted-foreground">
                        <div>{formatDateTime(o.updatedAt)}</div>
                        <div>{formatRelative(o.updatedAt)}</div>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button asChild size="sm" variant="ghost">
                            <Link href={`/app/orders/${o.id}`}>Open</Link>
                          </Button>
                          <RiskFlagDialog
                            order={o}
                            triggerVariant="outline"
                            triggerLabel={
                              o.risk.flagged ? "Unflag" : "Flag"
                            }
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>How this list works</CardTitle>
          <CardDescription>
            An order shows up here automatically when its Stripe payment fails
            or the checkout link expires. Operators can manually flag any
            order, paid, pending, anything, by opening it and clicking{" "}
            <span className="inline-flex items-center gap-1 font-medium text-foreground">
              <ShieldAlertIcon className="size-3" /> Flag for review
            </span>
            . Useful for tracking customer complaints before they escalate to
            a Stripe chargeback.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-[12.5px] text-muted-foreground space-y-2">
          <p className="flex items-start gap-2">
            <XCircleIcon className="mt-0.5 size-3.5 text-destructive shrink-0" />
            <span>
              <strong className="text-foreground">Payment failed</strong> means
              Stripe explicitly rejected the charge, review the failure
              reason, contact the customer, regenerate the link if appropriate.
            </span>
          </p>
          <p className="flex items-start gap-2">
            <ClockIcon className="mt-0.5 size-3.5 text-warning shrink-0" />
            <span>
              <strong className="text-foreground">Expired link</strong> means
              the customer never paid in time. Regenerate from the order page
              to send them a fresh link.
            </span>
          </p>
          <p className="flex items-start gap-2">
            <ShieldAlertIcon className="mt-0.5 size-3.5 text-destructive shrink-0" />
            <span>
              <strong className="text-foreground">Manually flagged</strong>{" "}
              orders stay here until you remove the flag. The note you wrote
              appears in the row.
            </span>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
