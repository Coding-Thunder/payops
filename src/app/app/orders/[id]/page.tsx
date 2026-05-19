import { notFound } from "next/navigation";

import { OrderDetailPageContent } from "@/components/features/orders/order-detail-page-content";
import { Permission } from "@/lib/constants/permissions";
import { NotFoundError, ForbiddenError } from "@/lib/errors";
import { requirePermission } from "@/server/auth/session";
import { getOrderById } from "@/server/services/order.service";

export const dynamic = "force-dynamic";

interface OrderPageProps {
  params: Promise<{ id: string }>;
}

/**
 * Read-only order detail. Linear routing — this IS the page. No
 * workspace tab shell, no internal tab strip. The server does the auth +
 * existence check at the edge so a deep link to a missing order returns
 * a real 404 before the client fetch fires; the visible content is
 * rendered by `OrderDetailPageContent`, which uses React Query to keep
 * the order in lock-step with realtime / polling updates.
 */
export default async function OrderDetailPage({ params }: OrderPageProps) {
  const user = await requirePermission(Permission.ORDER_VIEW_OWN);
  const { id } = await params;
  try {
    await getOrderById(id, { actor: user });
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    if (err instanceof ForbiddenError) notFound();
    throw err;
  }
  return <OrderDetailPageContent orderId={id} role={user.role} />;
}
