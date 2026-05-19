import { notFound } from "next/navigation";
import { render } from "@react-email/render";

import { PageHeader } from "@/components/common/page-header";
import { AdminTemplateEditor } from "@/components/features/email-templates/admin-template-editor";
import { Permission } from "@/lib/constants/permissions";
import {
  EMAIL_TEMPLATE_KEYS,
  type EmailTemplateKey,
} from "@/lib/constants/email-templates";
import { BookingType } from "@/lib/constants/enums";
import { env } from "@/lib/env";
import { requirePermission } from "@/server/auth/session";
import { getBranding } from "@/server/services/branding.service";
import { ensureSettingsDocument } from "@/server/services/settings.service";
import { listActiveProviders } from "@/server/services/provider.service";
import { listTemplateVersions } from "@/server/services/email-template.service";
import { PaymentConfirmationEmail } from "@/server/email/templates/payment-confirmation";
import { PaymentRequestEmail } from "@/server/email/templates/payment-request";
import {
  buildPaymentPreviewProps,
  buildPaymentRequestPreviewProps,
} from "@/server/email/preview-data";

export const metadata = { title: "Email template" };
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ key: string }>;
}

const TEMPLATE_LABELS: Record<EmailTemplateKey, string> = {
  "payment-confirmation": "Payment confirmation",
  "payment-request": "Payment request",
};
const TEMPLATE_DESCRIPTIONS: Record<EmailTemplateKey, string> = {
  "payment-confirmation":
    "Sent automatically by the system once Stripe confirms a successful payment.",
  "payment-request":
    "Sent by an agent from the composer right after order creation. Includes the Stripe payment CTA.",
};

export default async function AdminTemplateEditorPage({ params }: PageProps) {
  await requirePermission(Permission.EMAIL_TEMPLATE_VIEW);
  const { key } = await params;
  if (!EMAIL_TEMPLATE_KEYS.includes(key as EmailTemplateKey)) {
    notFound();
  }
  const templateKey = key as EmailTemplateKey;

  const [versions, branding, settings, providers] = await Promise.all([
    listTemplateVersions(templateKey),
    getBranding(),
    ensureSettingsDocument(),
    listActiveProviders(),
  ]);
  const activeVersion = versions.find((v) => v.active) ?? null;
  const provider = providers[0] ?? null;

  // Pre-render the initial preview server-side so the iframe is painted
  // on first navigation instead of waiting for a client-side fetch.
  let initialHtml = "";
  if (provider) {
    const baseArgs = {
      brandName: branding.brandName,
      appUrl: env.server.APP_URL,
      supportEmail: branding.supportEmail,
      supportPhone: branding.supportPhone,
      provider: {
        id: provider.key,
        name: provider.name,
        logo: provider.logo,
        primaryColor: provider.primaryColor,
        onPrimaryColor: provider.onPrimaryColor,
      },
      cancellationPolicy: settings.cancellationPolicy,
      cancellationPolicyVersion: settings.cancellationPolicyVersion,
      bookingType: BookingType.NEW_BOOKING,
    };
    if (templateKey === "payment-request") {
      const props = buildPaymentRequestPreviewProps(baseArgs);
      const merged = {
        ...props,
        greeting: activeVersion?.greeting ?? props.greeting,
        intro: activeVersion?.intro ?? props.intro,
        note: activeVersion?.note ?? props.note,
      };
      initialHtml = await render(<PaymentRequestEmail {...merged} />);
    } else {
      const props = buildPaymentPreviewProps(baseArgs);
      initialHtml = await render(<PaymentConfirmationEmail {...props} />);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Admin"
        title={TEMPLATE_LABELS[templateKey]}
        description={TEMPLATE_DESCRIPTIONS[templateKey]}
      />

      <AdminTemplateEditor
        templateKey={templateKey}
        templates={EMAIL_TEMPLATE_KEYS.map((k) => ({
          key: k,
          label: TEMPLATE_LABELS[k],
        }))}
        versions={versions}
        activeVersion={activeVersion}
        providers={providers.map((p) => ({ key: p.key, name: p.name }))}
        initialHtml={initialHtml}
      />
    </div>
  );
}
