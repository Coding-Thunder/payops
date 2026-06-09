import { notFound } from "next/navigation";
import { render } from "@react-email/render";

import { PageHeader } from "@/components/common/page-header";
import { AdminTemplateEditor } from "@/components/features/email-templates/admin-template-editor";
import { Permission } from "@/lib/constants/permissions";
import {
  SYSTEM_TEMPLATE_DESCRIPTIONS,
  SYSTEM_TEMPLATE_LABELS,
  SYSTEM_EMAIL_TEMPLATE_KEYS,
  isSystemTemplateKey,
} from "@/lib/constants/email-templates";
import { env } from "@/lib/env";
import { requirePermission } from "@/server/auth/session";
import { getBranding } from "@/server/services/branding.service";
import { ensureSettingsDocument } from "@/server/services/settings.service";
import {
  listAllTemplatesSummary,
  listTemplateVersions,
} from "@/server/services/email-template.service";
import { CustomTemplateEmail } from "@/server/email/templates/custom-template-email";
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

export default async function AdminTemplateEditorPage({ params }: PageProps) {
  const user = await requirePermission(Permission.EMAIL_TEMPLATE_VIEW);
  const { key } = await params;
  if (!user.orgId) notFound();

  // Per-org reads: editor binds to the actor's version stream + branding.
  // listAllTemplatesSummary doubles as the existence check for custom
  // kinds — a missing key 404s the same way an unknown system key did.
  const [summaries, branding, settings] = await Promise.all([
    listAllTemplatesSummary(user.orgId),
    getBranding(user.orgId),
    ensureSettingsDocument(user.orgId),
  ]);
  const current = summaries.find((s) => s.templateKey === key);
  if (!current && !isSystemTemplateKey(key)) {
    notFound();
  }

  const isSystem = isSystemTemplateKey(key);
  const displayName = current?.displayName ?? (isSystem ? SYSTEM_TEMPLATE_LABELS[key] : key);
  const description =
    current?.description ??
    (isSystem ? SYSTEM_TEMPLATE_DESCRIPTIONS[key] : null);

  const versions = await listTemplateVersions(key, user.orgId);
  const activeVersion = versions.find((v) => v.active) ?? null;

  // Pre-render the initial preview server-side so the iframe paints on
  // first navigation. System kinds render through UniversalOrderEmail
  // (with order line items / payment CTAs); custom kinds use the
  // simpler CustomTemplateEmail shell.
  let initialHtml = "";
  if (key === "payment-request") {
    const props = buildPaymentRequestPreviewProps({
      brandName: branding.brandName,
      appUrl: env.server.APP_URL,
      supportEmail: branding.supportEmail,
      supportPhone: branding.supportPhone,
      cancellationPolicy: settings.cancellationPolicy,
      cancellationPolicyVersion: settings.cancellationPolicyVersion,
    });
    const merged = {
      ...props,
      greeting: activeVersion?.greeting ?? props.greeting,
      intro: activeVersion?.intro ?? props.intro,
      note: activeVersion?.note ?? props.note,
    };
    initialHtml = await render(<UniversalOrderEmail {...merged} />);
  } else if (key === "payment-confirmation") {
    const props = buildPaymentPreviewProps({
      brandName: branding.brandName,
      appUrl: env.server.APP_URL,
      supportEmail: branding.supportEmail,
      supportPhone: branding.supportPhone,
      cancellationPolicy: settings.cancellationPolicy,
      cancellationPolicyVersion: settings.cancellationPolicyVersion,
    });
    initialHtml = await render(<UniversalOrderEmail {...props} />);
  } else {
    // Custom kind preview — render the shell with the saved copy
    // (falling back to placeholder text when nothing is saved yet so
    // the iframe isn't empty on first load).
    initialHtml = await render(
      <CustomTemplateEmail
        brandName={branding.brandName}
        eyebrow={displayName}
        preview={activeVersion?.subject ?? displayName}
        greeting={activeVersion?.greeting ?? "Hi {customerName},"}
        intro={
          activeVersion?.intro ??
          "This is a preview of the template. Write your copy on the left to see it render here."
        }
        note={activeVersion?.note ?? null}
        supportEmail={branding.supportEmail || null}
        footerNote={activeVersion?.footerNote ?? null}
      />,
    );
  }

  // Switcher sidebar list: all keys this tenant can edit (system +
  // their own custom kinds). Keeps the cross-template jump fast.
  const switcherOptions = [
    ...SYSTEM_EMAIL_TEMPLATE_KEYS.map((k) => ({
      key: k as string,
      label: SYSTEM_TEMPLATE_LABELS[k],
    })),
    ...summaries
      .filter((s) => s.kind === "custom")
      .map((s) => ({ key: s.templateKey, label: s.displayName })),
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={isSystem ? "Admin · System template" : "Admin · Custom template"}
        title={displayName}
        description={description ?? "Tenant-defined transactional email."}
      />

      <AdminTemplateEditor
        templateKey={key}
        templates={switcherOptions}
        versions={versions}
        activeVersion={activeVersion}
        initialHtml={initialHtml}
      />
    </div>
  );
}
