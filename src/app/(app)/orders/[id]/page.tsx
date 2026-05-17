import { notFound } from "next/navigation";

import { Permission } from "@/lib/constants/permissions";
import { NotFoundError, ForbiddenError } from "@/lib/errors";
import { requirePermission } from "@/server/auth/session";
import { getOrderById } from "@/server/services/order.service";

export const dynamic = "force-dynamic";

interface OrderPageProps {
  params: Promise<{ id: string }>;
}

/**
 * The workspace tab system owns the in-page rendering for /orders/[id].
 *
 * This server route still does the auth check + existence check so:
 *  - a deep link to a missing order returns a real 404 (notFound boundary
 *    runs BEFORE the workspace tab attempts a fetch and shows an error
 *    card)
 *  - users without ORDER_VIEW_OWN are redirected at the edge
 *
 * The visible content area is rendered by WorkspaceShell → TabContentHost
 * → OrderDetailsTabContent, which uses React Query to fetch the order
 * via /api/orders/[id] on the client. Server-side fetched data is NOT
 * passed down — the workspace tab is the single source of truth so a
 * deep link and a tab switch share one cache entry.
 */
export default async function OrderDetailPage({ params }: OrderPageProps) {
  const user = await requirePermission(Permission.ORDER_VIEW_OWN);
  const { id } = await params;
  try {
    // Existence + access check only. Result is intentionally discarded —
    // the client-side tab will refetch and own the data lifecycle.
    await getOrderById(id, { actor: user });
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    if (err instanceof ForbiddenError) notFound();
    throw err;
  }
  // Renders nothing — WorkspaceShell shows the tab content instead.
  return null;
}
