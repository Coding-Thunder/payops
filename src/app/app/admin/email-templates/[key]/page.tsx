import { notFound } from "next/navigation";
import { render } from "@react-email/render";

import { PageHeader } from "@/components/common/page-header";
import { AdminTemplateEditor } from "@/components/features/email-templates/admin-template-editor";
import { Permission } from "@/lib/constants/permissions";
import {
  EMAIL_TEMPLATE_KEYS,
  type EmailTemplateKey,
} from "@/lib/constants/email-templates";
import { env } from "@/lib/env";
import { requirePermission } from "@/server/auth/session";
import { getBranding } from "@/server/services/branding.service";
import { ensureSettingsDocument } from "@/server/services/settings.service";
import { listTemplateVersions } from "@/server/services/email-template.service";
import { UniversalOrderEmail } from "@/server/email/templates/universal-order-email";
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
  const user = await requirePermission(Permission.EMAIL_TEMPLATE_VIEW);
  const { key } = await params;
  if (!EMAIL_TEMPLATE_KEYS.includes(key as EmailTemplateKey)) {
    notFound();
  }
  const templateKey = key as EmailTemplateKey;

  // Per-org reads: editor binds to the actor's version stream + branding.
  const [versions, branding, settings] = await Promise.all([
    listTemplateVersions(templateKey, user.orgId),
    getBranding(user.orgId),
    ensureSettingsDocument(user.orgId),
  ]);
  const activeVersion = versions.find((v) => v.active) ?? null;

  // Pre-render the initial preview server-side so the iframe is painted
  // on first navigation instead of waiting for a client-side fetch.
  const baseArgs = {
    brandName: branding.brandName,
    appUrl: env.server.APP_URL,
    supportEmail: branding.supportEmail,
    supportPhone: branding.supportPhone,
    cancellationPolicy: settings.cancellationPolicy,
    cancellationPolicyVersion: settings.cancellationPolicyVersion,
  };
  let initialHtml = "";
  if (templateKey === "payment-request") {
    const props = buildPaymentRequestPreviewProps(baseArgs);
    const merged = {
      ...props,
      greeting: activeVersion?.greeting ?? props.greeting,
      intro: activeVersion?.intro ?? props.intro,
      note: activeVersion?.note ?? props.note,
    };
    initialHtml = await render(<UniversalOrderEmail {...merged} />);
  } else {
    const props = buildPaymentPreviewProps(baseArgs);
    initialHtml = await render(<UniversalOrderEmail {...props} />);
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
        initialHtml={initialHtml}
      />
    </div>
  );
}
