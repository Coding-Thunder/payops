import { notFound } from "next/navigation";

import { EmailComposePageContent } from "@/components/features/orders/email-compose-page-content";
import { Permission } from "@/lib/constants/permissions";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { requirePermission } from "@/server/auth/session";
import { getOrderById } from "@/server/services/order.service";

export const dynamic = "force-dynamic";

interface EmailComposeRouteProps {
  params: Promise<{ id: string }>;
}

/**
 * Step 2 of the linear flow: compose & send the payment-request email.
 *
 * Server route does the auth + existence guard, then hands off to the
 * client `EmailComposePageContent`. No workspace tab, no shell.
 */
export default async function EmailComposeRoute({
  params,
}: EmailComposeRouteProps) {
  const user = await requirePermission(Permission.ORDER_VIEW_OWN);
  const { id } = await params;
  try {
    await getOrderById(id, { actor: user });
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    if (err instanceof ForbiddenError) notFound();
    throw err;
  }
  return <EmailComposePageContent orderId={id} />;
}
