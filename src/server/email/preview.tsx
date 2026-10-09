import "server-only";

import { render } from "@react-email/render";

import type { EmailTemplateKey } from "@/lib/constants/email-templates";
import {
  BookingType,
  SERVICE_TYPES,
  ServiceType,
} from "@/lib/constants/enums";
import { env } from "@/lib/env";
import { resolvePublicBrand } from "@/server/email/identity";
import { getBranding } from "@/server/services/branding.service";
import { getSettings } from "@/server/services/settings.service";
import { getActiveTemplateContent } from "@/server/services/email-template.service";
import {
  acknowledgementFor,
  resolveServiceTerms,
} from "@/server/services/organization-legal.service";
import { resolveOrganizationServiceTypes } from "@/server/services/organization-service-types";
import { listActiveProviders } from "@/server/services/provider.service";
import { PaymentAuthorizedEmail } from "@/server/email/templates/payment-authorized";
import { PaymentConfirmationEmail } from "@/server/email/templates/payment-confirmation";
import { PaymentRequestEmail } from "@/server/email/templates/payment-request";
import {
  buildPaymentAuthorizedPreviewProps,
  buildPaymentPreviewProps,
  buildPaymentRequestPreviewProps,
} from "@/server/email/preview-data";
import type { ProviderDTO } from "@/types";

/**
 * EMAIL PREVIEWS — one renderer for every preview surface (Admin → Email
 * previews, the template editor's initial render and its live preview), so
 * they can never disagree with each other or with a real send.
 *
 * A preview has no order, so its two T&C inputs are passed EXPLICITLY:
 * the organization (the admin's selected brand) and the service being
 * previewed. Its terms come from `resolveServiceTerms` — the same resolver
 * that freezes a real order's terms at creation, which is what every real
 * email renders. Same inputs, same resolver, same text.
 */

/** The services a preview can show for an organization: exactly the ones it
 *  sells (the same rule as its order forms and Settings), or every service
 *  when no organization is selected. Never empty. */
export async function previewServicesFor(
  organizationId: string | null,
): Promise<ServiceType[]> {
  if (!organizationId) return [...SERVICE_TYPES];
  return resolveOrganizationServiceTypes(organizationId);
}

/** A requested preview service, or null when absent or not a service. */
export function parsePreviewService(value: unknown): ServiceType | null {
  return typeof value === "string" &&
    (SERVICE_TYPES as readonly string[]).includes(value)
    ? (value as ServiceType)
    : null;
}

export interface EmailPreviewInput {
  /** Whose terms: the admin's selected organization, or null for none. */
  organizationId: string | null;
  /** Which service's sample booking and terms. Required — never guessed. */
  serviceType: ServiceType;
  templateKey: EmailTemplateKey;
  providerKey?: string | null;
  bookingType?: BookingType | null;
  /** The template editor's unsaved copy, applied the way a real payment
   *  request applies the saved copy. Absent: the organization's saved copy
   *  for this service — exactly what a real send would apply. */
  draft?: {
    greeting?: string | null;
    intro?: string | null;
    note?: string | null;
  } | null;
}

export interface EmailPreview {
  /** Empty when the service has no active provider to sample. */
  html: string;
  providers: ProviderDTO[];
  provider: ProviderDTO | null;
}

export async function renderEmailPreview(
  input: EmailPreviewInput,
): Promise<EmailPreview> {
  const [branding, providers, terms, savedCopy, settings] = await Promise.all([
    getBranding(),
    listActiveProviders({ serviceType: input.serviceType }),
    resolveServiceTerms({
      organizationId: input.organizationId,
      serviceType: input.serviceType,
    }),
    input.draft
      ? null
      : getActiveTemplateContent(
          input.templateKey,
          input.organizationId,
          input.serviceType,
        ),
    getSettings(),
  ]);
  const copy = input.draft ?? savedCopy;
  // The brand the organization's real emails carry — not the deployment's.
  const brand = await resolvePublicBrand(input.organizationId, branding);
  const provider =
    providers.find((p) => p.key === input.providerKey) ?? providers[0] ?? null;
  if (!provider) return { html: "", providers, provider: null };

  const args = {
    brandName: brand.brandName,
    appUrl: env.server.APP_URL,
    supportEmail: brand.supportEmail,
    supportPhone: brand.supportPhone,
    provider: {
      id: provider.key,
      name: provider.name,
      logo: provider.logo,
      primaryColor: provider.primaryColor,
      onPrimaryColor: provider.onPrimaryColor,
    },
    bookingType: input.bookingType ?? BookingType.NEW_BOOKING,
    serviceType: input.serviceType,
    terms,
  };

  let html: string;
  if (input.templateKey === "payment-request") {
    const props = buildPaymentRequestPreviewProps(args);
    // The statement under the button is the one THIS service's customers
    // confirm — exactly as a real payment request shows it.
    const primaryCta = props.primaryCta
      ? {
          ...props.primaryCta,
          helperText: acknowledgementFor(
            input.serviceType,
            settings.consentMessage,
          ),
        }
      : props.primaryCta;
    html = await render(
      <PaymentRequestEmail
        {...props}
        primaryCta={primaryCta}
        greeting={copy?.greeting ?? props.greeting}
        intro={copy?.intro ?? props.intro}
        note={copy?.note ?? props.note}
      />,
    );
  } else if (input.templateKey === "payment-authorized") {
    html = await render(
      <PaymentAuthorizedEmail {...buildPaymentAuthorizedPreviewProps(args)} />,
    );
  } else {
    html = await render(
      <PaymentConfirmationEmail {...buildPaymentPreviewProps(args)} />,
    );
  }
  return { html, providers, provider };
}
