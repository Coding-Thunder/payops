import Link from "next/link";
import { notFound } from "next/navigation";
import {
  CalendarIcon,
  MailIcon,
  PhoneIcon,
  ShoppingBagIcon,
  UserIcon,
} from "lucide-react";

import { PageHeader } from "@/components/common/page-header";
import { OrderStatusBadge } from "@/components/common/status-badges";
import { SendTemplateButton } from "@/components/features/email-templates/send-template-button";
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
import { Permission } from "@/lib/constants/permissions";
import { NotFoundError } from "@/lib/errors";
import { formatCurrency, formatDateTime } from "@/lib/format";
import { requirePermission } from "@/server/auth/session";
import {
  getCustomerById,
  listOrdersForCustomer,
} from "@/server/services/customer.service";

export const metadata = { title: "Customer" };
export const dynamic = "force-dynamic";

interface CustomerPageProps {
  params: Promise<{ id: string }>;
}

/**
 * Customer detail. Lightweight surface: who they are, totals at a
 * glance, recent order history, and a Send Template CTA so an
 * operator can fire an ad-hoc email straight from the customer
 * record without bouncing through an order.
 *
 * Read-only by design — the customer record is a denormalised
 * convenience populated by the order pipeline. Editing happens on
 * the order detail page; this surface reflects what's already there.
 */
export default async function CustomerDetailPage({
  params,
}: CustomerPageProps) {
  const user = await requirePermission(Permission.ORDER_VIEW_OWN);
  const { id } = await params;
  if (!user.orgId) notFound();

  let customer;
  try {
    customer = await getCustomerById(user.orgId, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }

  const orders = await listOrdersForCustomer(user.orgId, customer.email);
  const lifetimeValue = orders
    .filter((o) => o.paidAt)
    .reduce((sum, o) => sum + o.amount, 0);
  const primaryCurrency = orders[0]?.currency ?? "USD";

  return (
    <div className="space-y-6">
      <PageHeader
        title={customer.name || customer.email}
        description={`Customer record · ${customer.email}`}
        actions={
          <SendTemplateButton
            defaultRecipient={customer.email}
            source={{ kind: "customer", customerId: customer.id }}
            label="Send template"
          />
        }
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardDescription className="flex items-center gap-1.5">
              <ShoppingBagIcon className="size-3.5" aria-hidden />
              Total orders
            </CardDescription>
            <CardTitle className="font-display text-[28px] tabular-nums">
              {customer.ordersCount}
            </CardTitle>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader>
            <CardDescription>Lifetime value (paid)</CardDescription>
            <CardTitle className="font-display text-[28px] tabular-nums">
              {formatCurrency(lifetimeValue, primaryCurrency)}
            </CardTitle>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader>
            <CardDescription className="flex items-center gap-1.5">
              <CalendarIcon className="size-3.5" aria-hidden />
              Last order
            </CardDescription>
            <CardTitle className="font-display text-[16px] font-medium">
              {customer.lastOrderAt
                ? formatDateTime(customer.lastOrderAt)
                : "No orders yet"}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Identity</CardTitle>
          <CardDescription>
            Customer record as captured by the order pipeline. Edit details on
            the order detail page; the latest values land here automatically.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3 text-[13px]">
            <Field icon={UserIcon} label="Name" value={customer.name} />
            <Field icon={MailIcon} label="Email" value={customer.email} />
            <Field
              icon={PhoneIcon}
              label="Phone"
              value={customer.phone || "—"}
            />
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Recent orders ({orders.length})
          </CardTitle>
          <CardDescription>
            Up to the 50 most recent active orders for this customer email.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {orders.length === 0 ? (
            <p className="px-6 py-8 text-center text-[13px] text-muted-foreground">
              No orders yet.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="hidden sm:table-cell">Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {orders.map((order) => (
                  <TableRow key={order.id}>
                    <TableCell>
                      <Link
                        href={`/app/orders/${order.id}`}
                        className="font-mono text-[12px] font-medium text-foreground hover:underline"
                      >
                        {order.orderNumber}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <OrderStatusBadge status={order.status} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(order.amount, order.currency)}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell text-muted-foreground">
                      {formatDateTime(order.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Field({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <div className="space-y-1">
      <dt className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        <Icon className="size-3" aria-hidden />
        {label}
      </dt>
      <dd className="font-medium text-foreground break-words">{value}</dd>
    </div>
  );
}
