import Link from "next/link";
import { render } from "@react-email/render";

import { PageHeader } from "@/components/common/page-header";
import { EmailPreviewControls } from "@/components/features/emails/email-preview-controls";
import { Permission } from "@/lib/constants/permissions";
import { BookingType, BOOKING_TYPES, ServiceType } from "@/lib/constants/enums";
import { env } from "@/lib/env";
import { cn } from "@/lib/utils";
import { requirePermission } from "@/server/auth/session";
import { getBranding } from "@/server/services/branding.service";
import { ensureSettingsDocument } from "@/server/services/settings.service";
import { listActiveProviders } from "@/server/services/provider.service";
import { previewLegalFor } from "@/server/services/organization-legal.service";
import { PaymentAuthorizedEmail } from "@/server/email/templates/payment-authorized";
import { PaymentConfirmationEmail } from "@/server/email/templates/payment-confirmation";
import { PaymentRequestEmail } from "@/server/email/templates/payment-request";
import {
  buildPaymentAuthorizedPreviewProps,
  buildPaymentPreviewProps,
  buildPaymentRequestPreviewProps,
} from "@/server/email/preview-data";

export const metadata = { title: "Email previews" };
export const dynamic = "force-dynamic";

const TEMPLATES = [
  {
    key: "payment-confirmation",
    label: "Payment confirmation",
    description: "Sent automatically once Stripe confirms payment.",
  },
  {
    key: "payment-request",
    label: "Payment request",
    description: "Sent by an agent right after order creation with the Stripe link.",
  },
  {
    key: "payment-authorized",
    label: "Payment authorized",
    description:
      "Sent when a manual-capture payment is held on the card, before it is charged.",
  },
] as const;

type TemplateKey = (typeof TEMPLATES)[number]["key"];

function isTemplateKey(value: string | undefined): value is TemplateKey {
  return TEMPLATES.some((t) => t.key === value);
}

/** The sample data sets the previews can render. */
const PREVIEW_SERVICES = [ServiceType.CAR_RENTAL, ServiceType.FLIGHT] as const;
type PreviewService = (typeof PREVIEW_SERVICES)[number];

interface EmailsPageProps {
  searchParams: Promise<{
    template?: string;
    provider?: string;
    bookingType?: string;
    service?: string;
  }>;
}

export default async function AdminEmailsPage({
  searchParams,
}: EmailsPageProps) {
  await requirePermission(Permission.SETTINGS_VIEW);

  const params = await searchParams;
  const activeService: PreviewService =
    params.service === ServiceType.FLIGHT
      ? ServiceType.FLIGHT
      : ServiceType.CAR_RENTAL;

  // Only providers of the previewed service — a flight sample is never shown
  // under a car rental brand — and that service's terms as the selected
  // organization's next order of it would freeze them.
  const [branding, , providers, legal] = await Promise.all([
    getBranding(),
    ensureSettingsDocument(),
    listActiveProviders({ serviceType: activeService }),
    previewLegalFor(activeService),
  ]);

  const activeTemplate: TemplateKey = isTemplateKey(params.template)
    ? params.template
    : "payment-confirmation";
  const activeProvider =
    providers.find((p) => p.key === params.provider) ?? providers[0] ?? null;
  const activeBookingType = (
    BOOKING_TYPES as readonly string[]
  ).includes(params.bookingType ?? "")
    ? (params.bookingType as BookingType)
    : BookingType.NEW_BOOKING;

  if (!activeProvider) {
    return (
      <div className="space-y-6">
        <PageHeader
          eyebrow="Admin"
          title="Email previews"
          description="Preview the customer transactional emails that this workspace sends."
        />
        <div className="rounded-lg border border-dashed border-border bg-card p-6 text-sm text-muted-foreground">
          {`No active ${activeService === ServiceType.FLIGHT ? "flight" : "car rental"} providers configured. Visit `}
          <strong>Admin → Providers</strong> to set one up before previewing
          the customer receipt, or preview the{" "}
          <Link
            className="underline"
            href={`?service=${activeService === ServiceType.FLIGHT ? ServiceType.CAR_RENTAL : ServiceType.FLIGHT}`}
          >
            {activeService === ServiceType.FLIGHT ? "car rental" : "flight"} emails
          </Link>
          .
        </div>
      </div>
    );
  }

  const baseArgs = {
    brandName: branding.brandName,
    appUrl: env.server.APP_URL,
    supportEmail: branding.supportEmail,
    supportPhone: branding.supportPhone,
    provider: {
      id: activeProvider.key,
      name: activeProvider.name,
      logo: activeProvider.logo,
      primaryColor: activeProvider.primaryColor,
      onPrimaryColor: activeProvider.onPrimaryColor,
    },
    cancellationPolicy: legal.cancellationPolicy,
    cancellationPolicyVersion: legal.cancellationPolicyVersion,
    termsAndConditions: legal.termsAndConditions,
    termsVersion: legal.termsVersion,
    bookingType: activeBookingType,
    serviceType: activeService,
    ...(activeService === ServiceType.FLIGHT ? { flightLegal: legal } : {}),
  };

  const html =
    activeTemplate === "payment-request"
      ? await render(
          <PaymentRequestEmail {...buildPaymentRequestPreviewProps(baseArgs)} />,
        )
      : activeTemplate === "payment-authorized"
        ? await render(
            <PaymentAuthorizedEmail
              {...buildPaymentAuthorizedPreviewProps(baseArgs)}
            />,
          )
        : await render(
            <PaymentConfirmationEmail {...buildPaymentPreviewProps(baseArgs)} />,
          );

  const activeTemplateLabel = TEMPLATES.find((t) => t.key === activeTemplate)!
    .label;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Admin"
        title="Email previews"
        description="Live preview of customer-facing transactional emails. Sample data only — nothing is sent."
      />

      <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
        <aside className="space-y-3">
          <TemplateListCard
            activeKey={activeTemplate}
            provider={activeProvider.key}
            bookingType={activeBookingType}
            service={activeService}
          />
          <EmailPreviewControls
            providers={providers.map((p) => ({ key: p.key, name: p.name }))}
            activeProvider={activeProvider.key}
            activeBookingType={activeBookingType}
            services={PREVIEW_SERVICES}
            activeService={activeService}
          />
        </aside>

        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-[13px] font-semibold tracking-tight">
              {activeTemplateLabel}
            </h2>
            <span className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
              {activeProvider.name} ·{" "}
              {activeBookingType.replace("_", " ").toLowerCase()}
            </span>
          </div>
          <div className="overflow-hidden rounded-lg border border-border bg-muted/30">
            <iframe
              title="Email preview"
              srcDoc={html}
              className="block h-[820px] w-full border-0 bg-white"
              sandbox="allow-same-origin"
            />
          </div>
        </section>
      </div>
    </div>
  );
}

function TemplateListCard({
  activeKey,
  provider,
  bookingType,
  service,
}: {
  activeKey: TemplateKey;
  provider: string;
  bookingType: BookingType;
  service: PreviewService;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="border-b border-border px-4 py-2.5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Templates
        </p>
      </div>
      <ul className="divide-y divide-border">
        {TEMPLATES.map((t) => {
          const active = t.key === activeKey;
          const search = new URLSearchParams({
            template: t.key,
            provider,
            bookingType,
            service,
          });
          return (
            <li
              key={t.key}
              className={cn(
                "text-[13px] transition-colors",
                active ? "bg-muted/40" : "hover:bg-muted/20",
              )}
            >
              <Link
                href={`/app/admin/emails?${search.toString()}`}
                className="block px-4 py-3"
              >
                <p
                  className={cn(
                    "font-medium",
                    active ? "text-foreground" : "text-foreground/85",
                  )}
                >
                  {t.label}
                </p>
                <p className="mt-1 text-[11.5px] leading-snug text-muted-foreground">
                  {t.description}
                </p>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
