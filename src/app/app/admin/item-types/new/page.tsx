import { PageHeader } from "@/components/common/page-header";
import { ItemTypeForm } from "@/components/features/item-types/item-type-form";
import { Permission } from "@/lib/constants/permissions";
import { requirePermission } from "@/server/auth/session";

export const metadata = { title: "New item type" };
export const dynamic = "force-dynamic";

export default async function NewItemTypePage() {
  await requirePermission(Permission.ITEM_TYPE_MANAGE);
  return (
    <div className="space-y-6">
      <PageHeader
        title="New item type"
        description="Describe the shape of a class of orderable thing. The create-order form will render the right inputs from the attribute schema you define here."
      />
      <ItemTypeForm />
    </div>
  );
}
