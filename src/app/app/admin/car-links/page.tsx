import { PageHeader } from "@/components/common/page-header";
import { AdminCarLinkTable } from "@/components/features/car-links";
import { Permission } from "@/lib/constants/permissions";
import { requirePermission } from "@/server/auth/session";
import { listCarLinks } from "@/server/services/car-link.service";

export const metadata = { title: "Car library" };
export const dynamic = "force-dynamic";

export default async function AdminCarLinksPage() {
  await requirePermission(Permission.CAR_LINK_MANAGE);
  const items = await listCarLinks({
    limit: 50,
    includeArchived: true,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Admin"
        title="Car library"
        description="Reusable car listings that agents can pick from while creating orders. Staff can add new entries inline; admins manage the catalog here."
      />
      <AdminCarLinkTable initialItems={items} />
    </div>
  );
}
