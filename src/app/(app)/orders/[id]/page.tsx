import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeftIcon } from "lucide-react";

import { ArchiveOrderButton } from "@/components/features/orders/archive-order-button";
import { OrderDetailsCard } from "@/components/features/orders/order-details-card";
import { OrderPaymentCard } from "@/components/features/orders/order-payment-card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/common/page-header";
import { Permission, roleHasPermission } from "@/lib/constants/permissions";
import { OrderStatus, RecordState } from "@/lib/constants/enums";
import { NotFoundError, ForbiddenError } from "@/lib/errors";
import { requirePermission } from "@/server/auth/session";
import { getOrderById } from "@/server/services/order.service";
import { OrderStatusBadge, RecordStateBadge } from "@/components/common/status-badges";

export const dynamic = "force-dynamic";

interface OrderPageProps {
  params: Promise<{ id: string }>;
}

export default async function OrderDetailPage({ params }: OrderPageProps) {
  const user = await requirePermission(Permission.ORDER_VIEW_OWN);
  const { id } = await params;
  let order;
  try {
    order = await getOrderById(id, { actor: user });
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    if (err instanceof ForbiddenError) notFound();
    throw err;
  }

  const canRegenerate = roleHasPermission(
    user.role,
    Permission.ORDER_REGENERATE_LINK,
  );
  const canArchive =
    roleHasPermission(user.role, Permission.ORDER_ARCHIVE) &&
    order.state === RecordState.ACTIVE &&
    order.status !== OrderStatus.PAID;

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="w-fit">
        <Link href="/orders">
          <ArrowLeftIcon className="size-3.5" />
          Back to orders
        </Link>
      </Button>
      <PageHeader
        title={order.orderNumber}
        description="Order details and payment status."
        actions={
          <div className="flex items-center gap-2">
            <OrderStatusBadge status={order.status} />
            {order.state !== RecordState.ACTIVE ? (
              <RecordStateBadge state={order.state} />
            ) : null}
            {canArchive ? <ArchiveOrderButton orderId={order.id} /> : null}
          </div>
        }
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          <OrderDetailsCard order={order} />
        </div>
        <div className="space-y-6">
          <OrderPaymentCard order={order} canRegenerate={canRegenerate} />
        </div>
      </div>
    </div>
  );
}
