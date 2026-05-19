import { PageHeader } from "@/components/common/page-header";
import { BrandingForm } from "@/components/features/branding/branding-form";
import { Permission, roleHasPermission } from "@/lib/constants/permissions";
import { requirePermission } from "@/server/auth/session";
import { getBranding } from "@/server/services/branding.service";

export const metadata = { title: "Branding" };
export const dynamic = "force-dynamic";

export default async function AdminBrandingPage() {
  const user = await requirePermission(Permission.BRANDING_VIEW);
  const branding = await getBranding();
  const canEdit = roleHasPermission(user.role, Permission.BRANDING_MANAGE);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Workspace branding"
        description="Customer-facing brand identity. Drives the confirmation email header, the /pay landing pages, and the Stripe checkout metadata. Operator-console chrome (sidebar, login) stays controlled by the APP_NAME deploy variable."
      />
      <BrandingForm initial={branding} canEdit={canEdit} />
    </div>
  );
}
