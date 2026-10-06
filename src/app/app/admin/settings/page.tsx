import { PageHeader } from "@/components/common/page-header";
import { ServiceLegalForm } from "@/components/features/settings/service-legal-form";
import { SettingsForm } from "@/components/features/settings/settings-form";
import { ServiceType } from "@/lib/constants/enums";
import { Permission, roleHasPermission } from "@/lib/constants/permissions";
import { getSelectedOrganization } from "@/server/auth/organization";
import { requirePermission } from "@/server/auth/session";
import {
  getOrganizationFlightLegal,
  getOrganizationHotelLegal,
} from "@/server/services/organization-legal.service";
import { resolveOrganizationServiceTypes } from "@/server/services/organization-service-types";
import { getSettings, ensureSettingsDocument } from "@/server/services/settings.service";

export const metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

export default async function AdminSettingsPage() {
  const user = await requirePermission(Permission.SETTINGS_VIEW);
  await ensureSettingsDocument();
  const settings = await getSettings();
  const canEdit = roleHasPermission(user.role, Permission.SETTINGS_UPDATE);

  // Terms are offered per service the SELECTED organization sells — the
  // same rule as its order forms (an organization with no stored list, and
  // no selection at all, read as car rental only). The car rental text is
  // the deployment-wide part of SettingsForm; flight and hotel terms belong
  // to the selected organization alone.
  const organization = await getSelectedOrganization();
  const serviceTypes = await resolveOrganizationServiceTypes(
    organization?.id ?? null,
  );
  const sellsCarRental = serviceTypes.includes(ServiceType.CAR_RENTAL);
  const [flightLegal, hotelLegal] = organization
    ? await Promise.all([
        serviceTypes.includes(ServiceType.FLIGHT)
          ? getOrganizationFlightLegal(organization.id)
          : null,
        serviceTypes.includes(ServiceType.HOTEL)
          ? getOrganizationHotelLegal(organization.id)
          : null,
      ])
    : [null, null];

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
          consentMode: settings.consentMode,
          consentMessage: settings.consentMessage,
          // The car rental text goes to the browser — and comes back in a
          // save — only for a brand that sells car rental.
          ...(sellsCarRental
            ? {
                cancellationPolicy: settings.cancellationPolicy,
                termsAndConditions: settings.termsAndConditions,
              }
            : {}),
        }}
        canEdit={canEdit}
        showCarRentalLegal={sellsCarRental}
      />
      {/* Keyed by organization so each form remounts with that brand's own
          text — never one brand's text under another brand's title. */}
      {flightLegal?.sellsFlight ? (
        <ServiceLegalForm
          key={`${flightLegal.organizationId}:FLIGHT`}
          serviceType={ServiceType.FLIGHT}
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
      {hotelLegal?.sellsHotel ? (
        <ServiceLegalForm
          key={`${hotelLegal.organizationId}:HOTEL`}
          serviceType={ServiceType.HOTEL}
          initial={{
            organizationId: hotelLegal.organizationId,
            brandName: hotelLegal.brandName,
            termsAndConditions: hotelLegal.termsAndConditions,
            termsVersion: hotelLegal.termsVersion,
            termsIsDefault: hotelLegal.termsIsDefault,
            cancellationPolicy: hotelLegal.cancellationPolicy,
            cancellationPolicyVersion: hotelLegal.cancellationPolicyVersion,
            policyIsDefault: hotelLegal.policyIsDefault,
            hasOrganizationWideText: hotelLegal.hasOrganizationWideText,
          }}
          canEdit={canEdit}
        />
      ) : null}
    </div>
  );
}
