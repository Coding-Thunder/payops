import { notFound } from "next/navigation";

import { PageHeader } from "@/components/common/page-header";
import { ItemForm } from "@/components/features/items/item-form";
import { Permission } from "@/lib/constants/permissions";
import { NotFoundError } from "@/lib/errors";
import { requirePermission } from "@/server/auth/session";
import { requireOrgId } from "@/server/db/org/org-context";
import { getItemById } from "@/server/services/item.service";
import { listActiveItemTypes } from "@/server/services/item-type.service";
import { getSettings } from "@/server/services/settings.service";

export const metadata = { title: "Edit catalog item" };
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function EditItemPage({ params }: PageProps) {
  const actor = await requirePermission(Permission.ITEM_MANAGE);
  const orgId = requireOrgId(actor.orgId);
  const { id } = await params;
  let item;
  try {
    item = await getItemById(id, {
      orgId,
      actorId: actor.id,
      actorName: actor.name,
    });
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  const [itemTypes, settings] = await Promise.all([
    listActiveItemTypes(actor.orgId ?? null),
    getSettings(actor.orgId),
  ]);
  return (
    <div className="space-y-6">
      <PageHeader
        title={item.name}
        description={`Editing this catalog item. Existing orders that referenced it keep their original snapshot — your edits affect future picks only.`}
      />
      <ItemForm
        initial={item}
        itemTypes={itemTypes}
        defaultCurrency={settings.defaultCurrency}
      />
    </div>
  );
}
