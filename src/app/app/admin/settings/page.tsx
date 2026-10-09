import { PageHeader } from "@/components/common/page-header";
import { ServiceLegalForm } from "@/components/features/settings/service-legal-form";
import { SettingsForm } from "@/components/features/settings/settings-form";
import { ServiceType } from "@/lib/constants/enums";
import { Permission, roleHasPermission } from "@/lib/constants/permissions";
import type { OrganizationLegalService } from "@/lib/validation";
import { getSelectedOrganization } from "@/server/auth/organization";
import { requirePermission } from "@/server/auth/session";
import {
  getOrganizationCarLegal,
  getOrganizationFlightLegal,
  getOrganizationHotelLegal,
} from "@/server/services/organization-legal.service";
import { resolveOrganizationServiceTypes } from "@/server/services/organization-service-types";
import { getSettings, ensureSettingsDocument } from "@/server/services/settings.service";

export const metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

type LegalView = Awaited<ReturnType<typeof getOrganizationFlightLegal>>;

export default async function AdminSettingsPage() {
  const user = await requirePermission(Permission.SETTINGS_VIEW);
  await ensureSettingsDocument();
  const settings = await getSettings();
  const canEdit = roleHasPermission(user.role, Permission.SETTINGS_UPDATE);

  // Terms belong to the SELECTED organization, one form per service it
  // sells — the same rule as its order forms. Each form edits that brand's
  // OWN text for that service only, so no edit here can reach another
  // brand's orders or another service's.
  //
  // The deployment-wide car rental text is only the default that brands
  // without car rental terms of their own inherit; it is edited in
  // SettingsForm with no brand selected (a single-brand deployment), never
  // from inside a brand.
  const organization = await getSelectedOrganization();
  const serviceTypes = organization
    ? await resolveOrganizationServiceTypes(organization.id)
    : [];
  const [carLegal, flightLegal, hotelLegal] = organization
    ? await Promise.all([
        serviceTypes.includes(ServiceType.CAR_RENTAL)
          ? getOrganizationCarLegal(organization.id)
          : null,
        serviceTypes.includes(ServiceType.FLIGHT)
          ? getOrganizationFlightLegal(organization.id)
          : null,
        serviceTypes.includes(ServiceType.HOTEL)
          ? getOrganizationHotelLegal(organization.id)
          : null,
      ])
    : [null, null, null];
  const editsDeploymentCarText = !organization;

  const legalForm = (
    serviceType: OrganizationLegalService,
    view: Omit<LegalView, "sellsFlight"> | null,
  ) =>
    view ? (
      // Keyed by organization and service so each form remounts with that
      // brand's own text — never one brand's text under another's title.
      <ServiceLegalForm
        key={`${view.organizationId}:${serviceType}`}
        serviceType={serviceType}
        initial={{
          organizationId: view.organizationId,
          brandName: view.brandName,
          termsAndConditions: view.termsAndConditions,
          termsVersion: view.termsVersion,
          termsIsDefault: view.termsIsDefault,
          cancellationPolicy: view.cancellationPolicy,
          cancellationPolicyVersion: view.cancellationPolicyVersion,
          policyIsDefault: view.policyIsDefault,
          hasOrganizationWideText: view.hasOrganizationWideText,
        }}
        canEdit={canEdit}
      />
    ) : null;

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
          // The acknowledgement statement is deployment-wide; car rental
          // customers of every brand confirm it (flight and hotel customers
          // confirm a built-in, service-neutral one — `acknowledgementFor`).
          consentMessage: settings.consentMessage,
          // The deployment default car rental text goes to the browser — and
          // comes back in a save — only with no brand selected.
          ...(editsDeploymentCarText
            ? {
                cancellationPolicy: settings.cancellationPolicy,
                termsAndConditions: settings.termsAndConditions,
              }
            : {}),
        }}
        canEdit={canEdit}
        showCarRentalLegal={editsDeploymentCarText}
      />
      {legalForm(ServiceType.CAR_RENTAL, carLegal)}
      {legalForm(ServiceType.FLIGHT, flightLegal)}
      {legalForm(ServiceType.HOTEL, hotelLegal)}
    </div>
  );
}
