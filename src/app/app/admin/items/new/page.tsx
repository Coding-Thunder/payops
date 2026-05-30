import { PageHeader } from "@/components/common/page-header";
import { ItemForm } from "@/components/features/items/item-form";
import { Permission } from "@/lib/constants/permissions";
import { requirePermission } from "@/server/auth/session";
import { listActiveItemTypes } from "@/server/services/item-type.service";
import { getSettings } from "@/server/services/settings.service";

export const metadata = { title: "Add catalog item" };
export const dynamic = "force-dynamic";

export default async function NewItemPage() {
  const actor = await requirePermission(Permission.ITEM_MANAGE);
  const [itemTypes, settings] = await Promise.all([
    listActiveItemTypes(actor.orgId ?? null),
    getSettings(actor.orgId),
  ]);
  return (
    <div className="space-y-6">
      <PageHeader
        title="Add catalog item"
        description="Save a product / service once. Operators pick it on every future order — name, SKU, attributes all pre-fill."
      />
      <ItemForm itemTypes={itemTypes} defaultCurrency={settings.defaultCurrency} />
    </div>
  );
}
