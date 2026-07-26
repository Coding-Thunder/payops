import Link from "next/link";
import { notFound } from "next/navigation";
import {
  Building2Icon,
  CalendarIcon,
  ClockIcon,
  MailIcon,
  PhoneIcon,
  ReceiptIcon,
  StickyNoteIcon,
  TagIcon,
  TrendingUpIcon,
  WalletIcon,
} from "lucide-react";

import { PageHeader } from "@/components/common/page-header";
import { StatCard } from "@/components/common/stat-card";
import { OrderStatusBadge } from "@/components/common/status-badges";
import { ClientTimeline } from "@/components/features/clients/client-timeline";
import { EditClientDialog } from "@/components/features/clients/edit-client-dialog";
import { SendTemplateButton } from "@/components/features/email-templates/send-template-button";
import { FadeIn } from "@/components/motion/fade-in";
import { Badge } from "@/components/ui/badge";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Permission,
  roleHasPermission,
} from "@/lib/constants/permissions";
import { NotFoundError } from "@/lib/errors";
import { formatCurrency, formatDate, formatDateTime } from "@/lib/format";
import { requirePermission } from "@/server/auth/session";
import {
  getClientProfile,
  getClientTimeline,
} from "@/server/services/client-profile.service";

export const metadata = { title: "Client" };
export const dynamic = "force-dynamic";

interface ClientPageProps {
  params: Promise<{ id: string }>;
}

/**
 * Client Profile — the system-of-record view for one customer. Lifetime
 * aggregates (revenue / orders / AOV / outstanding, all per-currency),
 * the full cross-entity timeline, and the order history in one place.
 *
 * Financials are computed on-read by `getClientProfile`; nothing here is
 * mocked. Edits are gated behind `CUSTOMER_MANAGE`; everyone with
 * `CUSTOMER_VIEW` gets the read surface.
 */
export default async function ClientProfilePage({ params }: ClientPageProps) {
  const user = await requirePermission(Permission.CUSTOMER_VIEW);
  const { id } = await params;

  let profile;
  let timeline;
  try {
    [profile, timeline] = await Promise.all([
      getClientProfile(user.orgId, id),
      getClientTimeline(user.orgId, id),
    ]);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }

  const { totals } = profile;
  const canManage = roleHasPermission(user.role, Permission.CUSTOMER_MANAGE);
  const currency = totals.currency ?? "USD";

  return (
    <div className="space-y-6">
      <PageHeader
        title={profile.name || profile.email}
        description={
          profile.company
            ? `${profile.company} · ${profile.email}`
            : `Client record · ${profile.email}`
        }
        actions={
          <div className="flex items-center gap-2">
            {canManage ? <EditClientDialog client={profile} /> : null}
            <SendTemplateButton
              defaultRecipient={profile.email}
              source={{ kind: "customer", customerId: profile.id }}
              label="Send template"
            />
          </div>
        }
      />

      {/* Lifetime KPIs — all in the client's PRIMARY currency. */}
      <FadeIn>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            icon={WalletIcon}
            iconTone="success"
            label="Lifetime revenue"
            value={formatCurrency(totals.revenue, currency)}
            caption={
              totals.multiCurrency
                ? `${totals.paidOrders} paid · ${currency} shown, other currencies present`
                : `${totals.paidOrders} paid ${plural(totals.paidOrders, "order")}`
            }
            variant="success"
          />
          <StatCard
            icon={ReceiptIcon}
            iconTone="info"
            label="Total orders"
            value={totals.totalOrders}
            caption={`${totals.paidOrders} paid · ${
              totals.totalOrders - totals.paidOrders
            } open`}
          />
          <StatCard
            icon={TrendingUpIcon}
            iconTone="purple"
            label="Avg order value"
            value={formatCurrency(totals.averageOrderValue, currency)}
            caption="Across paid orders"
          />
          <StatCard
            icon={ClockIcon}
            iconTone="warning"
            label="Outstanding"
            value={formatCurrency(totals.outstanding, currency)}
            caption={
              totals.refunded > 0
                ? `${formatCurrency(totals.refunded, currency)} refunded`
                : "Awaiting payment"
            }
            variant={totals.outstanding > 0 ? "warning" : "default"}
          />
        </div>
      </FadeIn>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Orders + Timeline */}
        <div className="lg:col-span-2">
          <Tabs defaultValue="timeline">
            <TabsList>
              <TabsTrigger value="timeline">Timeline</TabsTrigger>
              <TabsTrigger value="orders">
                Orders ({profile.orders.length})
              </TabsTrigger>
            </TabsList>

            <TabsContent value="timeline">
              <ClientTimeline events={timeline} />
            </TabsContent>

            <TabsContent value="orders">
              {profile.orders.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border bg-card/40 p-10 text-center">
                  <p className="text-sm font-medium text-foreground">
                    No orders yet
                  </p>
                  <p className="mt-1 text-[13px] text-muted-foreground">
                    Orders created for this client will appear here.
                  </p>
                </div>
              ) : (
                <Card className="overflow-hidden p-0">
                  <CardContent className="p-0">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Order</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead className="text-right">Amount</TableHead>
                          <TableHead className="hidden sm:table-cell text-right">
                            Created
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {profile.orders.map((o) => (
                          <TableRow key={o.id}>
                            <TableCell>
                              <Link
                                href={`/app/orders/${o.id}`}
                                className="font-mono text-[12px] font-medium text-foreground hover:underline"
                              >
                                {o.orderNumber}
                              </Link>
                            </TableCell>
                            <TableCell>
                              <OrderStatusBadge status={o.status} />
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatCurrency(o.amount, o.currency)}
                            </TableCell>
                            <TableCell className="hidden sm:table-cell text-right text-muted-foreground">
                              {formatDateTime(o.createdAt)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </CardContent>
                  {profile.orders.length >= 50 ? (
                    <p className="border-t border-border px-4 py-2.5 text-[12px] text-muted-foreground">
                      Showing the 50 most recent orders.
                    </p>
                  ) : null}
                </Card>
              )}
            </TabsContent>
          </Tabs>
        </div>

        {/* About */}
        <div className="lg:col-span-1">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">About</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <dl className="space-y-3 text-[13px]">
                <DetailRow icon={MailIcon} label="Email" value={profile.email} />
                <DetailRow
                  icon={PhoneIcon}
                  label="Phone"
                  value={profile.phone || "—"}
                />
                <DetailRow
                  icon={Building2Icon}
                  label="Company"
                  value={profile.company || "—"}
                />
                <DetailRow
                  icon={CalendarIcon}
                  label="Client since"
                  value={
                    profile.customerSince
                      ? formatDate(profile.customerSince)
                      : "—"
                  }
                />
                <DetailRow
                  icon={ClockIcon}
                  label="Last activity"
                  value={
                    profile.lastActivity
                      ? formatDate(profile.lastActivity)
                      : "No orders yet"
                  }
                />
              </dl>

              <div className="border-t border-border pt-3">
                <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <TagIcon className="size-3" aria-hidden />
                  Tags
                </p>
                {profile.tags.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {profile.tags.map((t) => (
                      <Badge key={t} variant="secondary">
                        {t}
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <p className="text-[13px] text-muted-foreground">
                    No tags yet.
                  </p>
                )}
              </div>

              <div className="border-t border-border pt-3">
                <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <StickyNoteIcon className="size-3" aria-hidden />
                  Notes
                </p>
                {profile.notes ? (
                  <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground">
                    {profile.notes}
                  </p>
                ) : (
                  <p className="text-[13px] text-muted-foreground">
                    No notes yet.
                    {canManage ? " Use Edit to add context for your team." : ""}
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function DetailRow({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="flex items-center gap-1.5 text-muted-foreground">
        <Icon className="size-3.5" aria-hidden />
        {label}
      </dt>
      <dd className="min-w-0 break-words text-right font-medium text-foreground">
        {value}
      </dd>
    </div>
  );
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}
