import { PageHeader } from "@/components/common/page-header";
import { SettingsForm } from "@/components/features/settings/settings-form";
import { Permission, roleHasPermission } from "@/lib/constants/permissions";
import { requirePermission } from "@/server/auth/session";
import { getSettings, ensureSettingsDocument } from "@/server/services/settings.service";

export const metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

export default async function AdminSettingsPage() {
  const user = await requirePermission(Permission.SETTINGS_VIEW);
  await ensureSettingsDocument();
  const settings = await getSettings();
  const canEdit = roleHasPermission(user.role, Permission.SETTINGS_UPDATE);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Operational settings"
        description="Configure how orders are generated, what booking types are accepted, and the customer-facing details that appear in emails and redirects."
      />
      <SettingsForm
        initial={{
          paymentExpiryHours: settings.paymentExpiryHours,
          orderPrefix: settings.orderPrefix,
          allowedBookingTypes: settings.allowedBookingTypes,
          defaultCurrency: settings.defaultCurrency,
          successRedirectUrl: settings.successRedirectUrl,
          cancelRedirectUrl: settings.cancelRedirectUrl,
          cancellationPolicy: settings.cancellationPolicy,
          consentMode: settings.consentMode,
          consentMessage: settings.consentMessage,
          termsAndConditions: settings.termsAndConditions,
        }}
        canEdit={canEdit}
      />
    </div>
  );
}
