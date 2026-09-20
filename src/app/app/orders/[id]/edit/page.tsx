import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeftIcon } from "lucide-react";

import { EditOrderForm } from "@/components/features/orders/edit-order-form";
import { PageHeader } from "@/components/common/page-header";
import { Button } from "@/components/ui/button";
import { RecordState } from "@/lib/constants/enums";
import { Permission } from "@/lib/constants/permissions";
import { PAID_FEATURES_ENABLED } from "@/lib/paid-features";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { requirePermission } from "@/server/auth/session";
import { getOrderById } from "@/server/services/order.service";
import { listActiveProviders } from "@/server/services/provider.service";

export const metadata = { title: "Edit order" };
export const dynamic = "force-dynamic";

interface EditOrderRouteProps {
  params: Promise<{ id: string }>;
}

/**
 * Edit Order — a customer-requested change, made on the same form that
 * created the order.
 *
 * Gated on ORDER_UPDATE, the permission the modify service re-checks. An
 * archived order is read-only everywhere else in the app, so it is not
 * editable here either: it redirects to the order page. An order outside
 * the operator's scope renders as not found rather than revealing that the
 * id exists.
 */
export default async function EditOrderRoute({ params }: EditOrderRouteProps) {
  const { id } = await params;
  // Edit order (MCO changes) is a paid feature, switched off until paid for
  // (see src/lib/paid-features.ts): the order page is where it leads instead.
  if (!PAID_FEATURES_ENABLED) redirect(`/app/orders/${id}`);
  // Someone who may view the order but not change it (STAFF) is sent to the
  // order itself rather than shown an error page.
  let user;
  try {
    user = await requirePermission(Permission.ORDER_UPDATE);
  } catch (err) {
    if (err instanceof ForbiddenError) redirect(`/app/orders/${id}`);
    throw err;
  }

  let order;
  try {
    order = await getOrderById(id, { actor: user });
  } catch (err) {
    if (err instanceof NotFoundError || err instanceof ForbiddenError) notFound();
    throw err;
  }
  // Archived while the form was open (the realtime refresh re-runs this):
  // show the order, which says it is archived, not a bare "Page not found".
  if (order.state === RecordState.ARCHIVED) redirect(`/app/orders/${order.id}`);

  const providers = await listActiveProviders();
  const emailHref = `/app/orders/${order.id}/email`;

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="w-fit">
        <Link href={emailHref}>
          <ArrowLeftIcon className="size-3.5" />
          Back to payment request
        </Link>
      </Button>
      <PageHeader
        // The shared header truncates its title. Here the order number IS
        // the point — the operator must be able to confirm which order they
        // are changing — so let it wrap on narrow screens instead.
        className="[&_h1]:whitespace-normal"
        title={`Edit order · ${order.orderNumber}`}
        description="Record a customer-requested change. This order is updated in place — no new order is created."
      />
      <EditOrderForm order={order} providers={providers} />
    </div>
  );
}
