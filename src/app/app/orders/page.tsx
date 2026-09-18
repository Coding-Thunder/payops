import Link from "next/link";
import { redirect } from "next/navigation";
import { PlusIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ExportOrdersButton } from "@/components/features/orders/export-orders-button";
import { OrderFilters } from "@/components/features/orders/order-filters";
import { OrderSelectionProvider } from "@/components/features/orders/order-selection";
import { OrderTable } from "@/components/features/orders/order-table";
import { Pagination } from "@/components/features/orders/pagination";
import { PageHeader } from "@/components/common/page-header";
import { Permission, roleHasPermission } from "@/lib/constants/permissions";
import { listOrdersQuerySchema } from "@/lib/validation";
import { requirePermission } from "@/server/auth/session";
import { listOrders } from "@/server/services/order.service";

export const metadata = { title: "Orders" };
export const dynamic = "force-dynamic";

interface OrdersPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function OrdersPage({ searchParams }: OrdersPageProps) {
  const user = await requirePermission(Permission.ORDER_VIEW_OWN);
  const canSeeAll = roleHasPermission(user.role, Permission.ORDER_VIEW_ALL);
  const canDelete = roleHasPermission(user.role, Permission.ORDER_DELETE);

  const sp = await searchParams;
  // A hand-edited or over-long URL must not take the whole page down. The
  // invalid parts are dropped (an over-long search is shortened) and the
  // browser is sent to the cleaned URL, so the filter controls describe the
  // list actually shown.
  const flat = flatten(sp);
  const cleaned = cleanListQuery(flat);
  if (cleaned !== null) redirect(cleaned ? `/app/orders?${cleaned}` : "/app/orders");
  const params = listOrdersQuerySchema.parse(flat);
  const data = await listOrders(params, { actor: user });

  return (
    // Export acts on the orders ticked in the table below, so the header's
    // bulk action and the table's checkboxes share one selection.
    <OrderSelectionProvider>
      <div className="space-y-6">
        <PageHeader
          title="Orders"
          description={
            canSeeAll
              ? "Every payable order across the operation."
              : "Orders you have created."
          }
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <ExportOrdersButton />
              <Button asChild>
                <Link href="/app/orders/create">
                  <PlusIcon className="size-4" />
                  New order
                </Link>
              </Button>
            </div>
          }
        />

        <OrderFilters canSeeAll={canSeeAll} />
        <OrderTable
          items={data.items}
          canDelete={canDelete}
          selectable
          filtered={Boolean(
            params.q ||
            params.status ||
            params.bookingType ||
            params.mine ||
            params.from ||
            params.to,
          )}
          emptyAction={
            <Button asChild>
              <Link href="/app/orders/create">
                <PlusIcon className="size-4" />
                Create order
              </Link>
            </Button>
          }
        />
        <Pagination
          page={data.page}
          pageSize={data.pageSize}
          total={data.total}
        />
      </div>
    </OrderSelectionProvider>
  );
}

/** The query without its invalid parts, or null when nothing is invalid. */
function cleanListQuery(flat: Record<string, string>): string | null {
  const next = { ...flat };
  if (next.q && next.q.length > 120) next.q = next.q.slice(0, 120);
  for (let i = 0; i < 10; i++) {
    const parsed = listOrdersQuerySchema.safeParse(next);
    if (parsed.success) break;
    const bad = new Set(parsed.error.issues.map((issue) => String(issue.path[0])));
    for (const key of bad) delete next[key];
  }
  const changed =
    Object.keys(next).length !== Object.keys(flat).length ||
    Object.entries(next).some(([k, v]) => flat[k] !== v);
  return changed ? new URLSearchParams(next).toString() : null;
}

function flatten(
  sp: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === "string") out[k] = v;
    else if (Array.isArray(v) && v.length > 0) out[k] = v[0];
  }
  return out;
}
