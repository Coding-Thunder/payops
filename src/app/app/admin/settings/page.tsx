import { PageHeader } from "@/components/common/page-header";
import { FlightLegalForm } from "@/components/features/settings/flight-legal-form";
import { SettingsForm } from "@/components/features/settings/settings-form";
import { Permission, roleHasPermission } from "@/lib/constants/permissions";
import { getSelectedOrganization } from "@/server/auth/organization";
import { requirePermission } from "@/server/auth/session";
import { getOrganizationFlightLegal } from "@/server/services/organization-legal.service";
import { getSettings, ensureSettingsDocument } from "@/server/services/settings.service";

export const metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

export default async function AdminSettingsPage() {
  const user = await requirePermission(Permission.SETTINGS_VIEW);
  await ensureSettingsDocument();
  const settings = await getSettings();
  const canEdit = roleHasPermission(user.role, Permission.SETTINGS_UPDATE);

  // Everything in SettingsForm is deployment-wide. Flight terms are not:
  // they belong to the organization selected in the switcher, and are only
  // offered when that organization sells flights.
  const organization = await getSelectedOrganization();
  const flightLegal = organization
    ? await getOrganizationFlightLegal(organization.id)
    : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Operational settings"
        description="Configure how orders are generated, what booking types are accepted, and the customer-facing details that appear in emails and redirects. Unless a section names a brand, these settings are shared by every brand on this deployment."
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
      {flightLegal?.sellsFlight ? (
        // Keyed by organization so the form remounts with each brand's own
        // text — never one brand's text under another brand's title.
        <FlightLegalForm
          key={flightLegal.organizationId}
          initial={{
            organizationId: flightLegal.organizationId,
            brandName: flightLegal.brandName,
            termsAndConditions: flightLegal.termsAndConditions,
            termsVersion: flightLegal.termsVersion,
            termsIsDefault: flightLegal.termsIsDefault,
            cancellationPolicy: flightLegal.cancellationPolicy,
            cancellationPolicyVersion: flightLegal.cancellationPolicyVersion,
            policyIsDefault: flightLegal.policyIsDefault,
            hasOrganizationWideText: flightLegal.hasOrganizationWideText,
          }}
          canEdit={canEdit}
        />
      ) : null}
    </div>
  );
}
