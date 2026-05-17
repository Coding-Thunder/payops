import { Permission } from "@/lib/constants/permissions";
import { requirePermission } from "@/server/auth/session";

export const metadata = { title: "Create order" };
export const dynamic = "force-dynamic";

/**
 * The workspace tab system owns the in-page rendering for /orders/create
 * and /orders/create?draft=…
 *
 * This route exists to (a) enforce ORDER_CREATE at the edge and (b) give
 * deep links a real URL. WorkspaceShell mounts the CREATE_ORDER or
 * DRAFT_ORDER tab and renders its content.
 */
export default async function CreateOrderPage() {
  await requirePermission(Permission.ORDER_CREATE);
  return null;
}
