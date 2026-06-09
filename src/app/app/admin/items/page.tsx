import Link from "next/link";

import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/common/page-header";
import { ItemTable } from "@/components/features/items/item-table";
import { Permission } from "@/lib/constants/permissions";
import { requirePermission } from "@/server/auth/session";
import { requireOrgId } from "@/server/db/org/org-context";
import { listAllItems } from "@/server/services/item.service";

export const metadata = { title: "Catalog items" };
export const dynamic = "force-dynamic";

export default async function AdminItemsPage() {
  const actor = await requirePermission(Permission.ITEM_MANAGE);
  const orgId = requireOrgId(actor.orgId);
  const items = await listAllItems({
    orgId,
    actorId: actor.id,
    actorName: actor.name,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Catalog"
        description="Reusable products / services your operators pick from when creating an order. Saved here once, picked from a dropdown forever after."
        actions={
          <Button asChild>
            <Link href="/app/admin/items/new">Add item</Link>
          </Button>
        }
      />
      <ItemTable items={items} />
    </div>
  );
}
