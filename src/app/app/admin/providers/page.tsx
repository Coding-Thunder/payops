import { PageHeader } from "@/components/common/page-header";
import { AdminProviderTable } from "@/components/features/providers/admin-provider-table";
import { CreateProviderDialog } from "@/components/features/providers/create-provider-dialog";
import { Permission } from "@/lib/constants/permissions";
import { getOrganization } from "@/server/auth/organization";
import { requirePermission } from "@/server/auth/session";
import { listProviders } from "@/server/services/provider.service";

export const metadata = { title: "Providers" };
export const dynamic = "force-dynamic";

export default async function AdminProvidersPage() {
  await requirePermission(Permission.PROVIDER_VIEW);
  const [items, organization] = await Promise.all([
    listProviders({ includeAll: true }),
    getOrganization(),
  ]);
  const { serviceTypes } = organization;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Providers"
        description="Add, edit, enable or disable the suppliers customers can be billed under. Disabled providers are hidden from order creation but stay visible on existing orders."
        actions={<CreateProviderDialog serviceTypes={serviceTypes} />}
      />
      <AdminProviderTable items={items} serviceTypes={serviceTypes} />
    </div>
  );
}
