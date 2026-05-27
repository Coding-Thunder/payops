import { PageHeader } from "@/components/common/page-header";
import { Permission } from "@/lib/constants/permissions";
import { requirePermission } from "@/server/auth/session";

import { BusinessSetupWizard } from "./_components/wizard";

export const metadata = { title: "Set up your business" };
export const dynamic = "force-dynamic";

/**
 * Pass 6b — Business onboarding wizard entry point.
 *
 * Server component just gates on `ITEM_TYPE_MANAGE` and hands the
 * client wizard the org-id. All step transitions happen client-side
 * via React state + URL search params; the final commit posts to
 * `/api/onboarding/business-setup`.
 *
 * Re-entry: the wizard allows append (user decision in Pass 6b
 * verification), so this page does NOT check whether ItemTypes
 * already exist. The dashboard checklist hides the "Set up your
 * business" entry once any ItemType is present, but a direct URL
 * visit still lands here — useful for tenants expanding into a
 * second vertical.
 */
export default async function BusinessSetupPage() {
  await requirePermission(Permission.ITEM_TYPE_MANAGE);
  return (
    <div className="space-y-6">
      <PageHeader
        title="Set up your business"
        description="Pick what you sell. We'll preconfigure the order form and emails so you can take payments today."
      />
      <BusinessSetupWizard />
    </div>
  );
}
