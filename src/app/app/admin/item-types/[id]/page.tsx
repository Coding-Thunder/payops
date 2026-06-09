import { notFound } from "next/navigation";

import { PageHeader } from "@/components/common/page-header";
import { ItemTypeForm } from "@/components/features/item-types/item-type-form";
import { Permission } from "@/lib/constants/permissions";
import { NotFoundError } from "@/lib/errors";
import { requirePermission } from "@/server/auth/session";
import { requireOrgId } from "@/server/db/org/org-context";
import { getItemTypeById } from "@/server/services/item-type.service";

export const metadata = { title: "Edit item type" };
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function EditItemTypePage({ params }: PageProps) {
  const actor = await requirePermission(Permission.ITEM_TYPE_MANAGE);
  const orgId = requireOrgId(actor.orgId);
  const { id } = await params;
  let item;
  try {
    item = await getItemTypeById(id, { orgId, actorId: actor.id });
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  return (
    <div className="space-y-6">
      <PageHeader
        title={item.name}
        description={`Editing ${item.key}. The key is immutable; everything else can be revised.`}
      />
      <ItemTypeForm initial={item} />
    </div>
  );
}
