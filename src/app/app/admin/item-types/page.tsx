import Link from "next/link";

import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/common/page-header";
import { ItemTypeTable } from "@/components/features/item-types/item-type-table";
import { Permission } from "@/lib/constants/permissions";
import { requirePermission } from "@/server/auth/session";
import { requireOrgId } from "@/server/db/org/org-context";
import { listAllItemTypes } from "@/server/services/item-type.service";

export const metadata = { title: "Item types" };
export const dynamic = "force-dynamic";

export default async function AdminItemTypesPage() {
  const actor = await requirePermission(Permission.ITEM_TYPE_MANAGE);
  const orgId = requireOrgId(actor.orgId);
  const items = await listAllItemTypes({ orgId, actorId: actor.id });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Item types"
        description="Define the kinds of orderable things this organization sells. Each type drives the create-order form and the confirmation email layout."
        actions={
          <Button asChild>
            <Link href="/app/admin/item-types/new">New item type</Link>
          </Button>
        }
      />
      <ItemTypeTable items={items} />
    </div>
  );
}
