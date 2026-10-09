import { notFound, redirect } from "next/navigation";

import { PageHeader } from "@/components/common/page-header";
import { AdminTemplateEditor } from "@/components/features/email-templates/admin-template-editor";
import { Permission } from "@/lib/constants/permissions";
import {
  EMAIL_TEMPLATE_KEYS,
  type EmailTemplateKey,
} from "@/lib/constants/email-templates";
import { getSelectedOrganization } from "@/server/auth/organization";
import { requirePermission } from "@/server/auth/session";
import { ensureSettingsDocument } from "@/server/services/settings.service";
import { listTemplateVersions } from "@/server/services/email-template.service";
import {
  parsePreviewService,
  previewServicesFor,
  renderEmailPreview,
} from "@/server/email/preview";

export const metadata = { title: "Email template" };
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ key: string }>;
  searchParams: Promise<{ service?: string }>;
}

const TEMPLATE_LABELS: Record<EmailTemplateKey, string> = {
  "payment-confirmation": "Payment confirmation",
  "payment-request": "Payment request",
  "payment-authorized": "Payment authorized",
};
const TEMPLATE_DESCRIPTIONS: Record<EmailTemplateKey, string> = {
  "payment-confirmation":
    "Sent automatically by the system once Stripe confirms a successful payment.",
  "payment-request":
    "Sent by an agent from the composer right after order creation. Includes the Stripe payment CTA.",
  "payment-authorized":
    "Sent automatically when a card is authorized but NOT yet charged. Only organizations on manual capture ever send this.",
};

export default async function AdminTemplateEditorPage({
  params,
  searchParams,
}: PageProps) {
  await requirePermission(Permission.EMAIL_TEMPLATE_VIEW);
  const { key } = await params;
  if (!EMAIL_TEMPLATE_KEYS.includes(key as EmailTemplateKey)) {
    notFound();
  }
  const templateKey = key as EmailTemplateKey;

  // The preview is of ONE service, named in the URL — one the selected
  // organization sells — and shows that service's terms for that
  // organization. Never a default service: a missing one is made explicit.
  const organization = await getSelectedOrganization();
  const services = await previewServicesFor(organization?.id ?? null);
  const requested = parsePreviewService((await searchParams).service);
  if (!requested || !services.includes(requested)) {
    redirect(`/app/admin/email-templates/${templateKey}?service=${services[0]}`);
  }
  const serviceType = requested;

  // Copy is per service too: this service's versions only.
  const [versions] = await Promise.all([
    listTemplateVersions(templateKey, serviceType),
    ensureSettingsDocument(),
  ]);
  const activeVersion = versions.find((v) => v.active) ?? null;

  // Pre-render the initial preview server-side so the iframe is painted
  // on first navigation instead of waiting for a client-side fetch — with
  // the same renderer, inputs and resolver as the live preview.
  // Its draft is exactly the editor's starting draft (this service's live
  // version, or nothing), so the first paint and the live preview agree.
  const preview = await renderEmailPreview({
    organizationId: organization?.id ?? null,
    serviceType,
    templateKey,
    draft: {
      greeting: activeVersion?.greeting ?? null,
      intro: activeVersion?.intro ?? null,
      note: activeVersion?.note ?? null,
    },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Admin"
        title={TEMPLATE_LABELS[templateKey]}
        description={TEMPLATE_DESCRIPTIONS[templateKey]}
      />

      {/* Keyed by service: each service is its own copy, so switching
          service starts from that service's live version, never carrying
          another service's unsaved draft across. */}
      <AdminTemplateEditor
        key={serviceType}
        templateKey={templateKey}
        templates={EMAIL_TEMPLATE_KEYS.map((k) => ({
          key: k,
          label: TEMPLATE_LABELS[k],
        }))}
        versions={versions}
        activeVersion={activeVersion}
        serviceType={serviceType}
        services={services}
        providers={preview.providers.map((p) => ({ key: p.key, name: p.name }))}
        initialHtml={preview.html}
      />
    </div>
  );
}
