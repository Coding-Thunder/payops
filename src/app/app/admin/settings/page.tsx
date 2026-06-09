import { PageHeader } from "@/components/common/page-header";
import { SettingsForm } from "@/components/features/settings/settings-form";
import { Permission, roleHasPermission } from "@/lib/constants/permissions";
import { requirePermission } from "@/server/auth/session";
import { getSettings, ensureSettingsDocument } from "@/server/services/settings.service";

export const metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

export default async function AdminSettingsPage() {
  const user = await requirePermission(Permission.SETTINGS_VIEW);
  // Per-tenant settings: pass user.orgId so admin reads/edits THEIR
  // workspace's row, not the legacy singleton (env-seeded).
  await ensureSettingsDocument(user.orgId);
  const settings = await getSettings(user.orgId);
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
          defaultCurrency: settings.defaultCurrency,
          successRedirectUrl: settings.successRedirectUrl,
          cancelRedirectUrl: settings.cancelRedirectUrl,
          cancellationPolicy: settings.cancellationPolicy,
          consentMode: settings.consentMode,
          consentMessage: settings.consentMessage,
        }}
        canEdit={canEdit}
      />
    </div>
  );
}
