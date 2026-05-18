import { Permission } from "@/lib/constants/permissions";
import { requirePermission } from "@/server/auth/session";

export const metadata = { title: "Send payment request" };
export const dynamic = "force-dynamic";

/**
 * The workspace tab system owns the in-page rendering for
 * /orders/[id]/compose. This route exists to (a) enforce permissions
 * at the edge and (b) give the URL a real page so refresh / deep-link
 * works. WorkspaceShell mounts the PAYMENT_COMPOSE tab and renders its
 * content.
 */
export default async function ComposePaymentRequestPage() {
  await requirePermission(Permission.ORDER_VIEW_OWN);
  return null;
}
