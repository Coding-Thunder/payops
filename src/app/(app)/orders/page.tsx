import Link from "next/link";
import { PlusIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { OrderFilters } from "@/components/features/orders/order-filters";
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

  const sp = await searchParams;
  const params = listOrdersQuerySchema.parse(flatten(sp));
  const data = await listOrders(params, { actor: user });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Orders"
        description={
          canSeeAll
            ? "Every payable order across the operation."
            : "Orders you have created."
        }
        actions={
          <Button asChild>
            <Link href="/orders/create">
              <PlusIcon className="size-4" />
              New order
            </Link>
          </Button>
        }
      />

      <OrderFilters canSeeAll={canSeeAll} />
      <OrderTable
        items={data.items}
        emptyAction={
          <Button asChild>
            <Link href="/orders/create">
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
  );
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
