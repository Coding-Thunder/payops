import { notFound } from "next/navigation";

import { PageHeader } from "@/components/common/page-header";
import { AdminTemplateEditor } from "@/components/features/email-templates/admin-template-editor";
import { Permission } from "@/lib/constants/permissions";
import {
  SYSTEM_TEMPLATE_DESCRIPTIONS,
  SYSTEM_TEMPLATE_LABELS,
  SYSTEM_EMAIL_TEMPLATE_KEYS,
  isSystemTemplateKey,
} from "@/lib/constants/email-templates";
import { requirePermission } from "@/server/auth/session";
import {
  listAllTemplatesSummary,
  listTemplateVersions,
} from "@/server/services/email-template.service";
import { renderTemplatePreview } from "@/server/services/template-preview.service";

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
  const summaries = await listAllTemplatesSummary(user.orgId);
  const current = summaries.find((s) => s.templateKey === key);
  if (!current && !isSystemTemplateKey(key)) {
    notFound();
  }

  const isSystem = isSystemTemplateKey(key);
  const displayName =
    current?.displayName ?? (isSystem ? SYSTEM_TEMPLATE_LABELS[key] : key);
  const description =
    current?.description ??
    (isSystem ? SYSTEM_TEMPLATE_DESCRIPTIONS[key] : null);

  const versions = await listTemplateVersions(key, user.orgId);
  const activeVersion = versions.find((v) => v.active) ?? null;

  // First paint is rendered server-side so the iframe isn't blank on
  // navigation — through the SAME renderer the live-preview endpoint
  // calls, so the pane can't change layout the moment the operator
  // types (which is exactly what it used to do).
  const initialHtml = await renderTemplatePreview({
    templateKey: key,
    displayName,
    draft: activeVersion ?? {},
    orgId: user.orgId,
  });

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
        eyebrow={isSystem ? "Admin · Automated email" : "Admin · Custom template"}
        title={displayName}
        description={
          description ??
          (isSystem
            ? "Fired automatically by a workflow event. Edit the copy; the layout belongs to the payment flow."
            : "Yours to write, reuse, and send from any client.")
        }
      />

      <AdminTemplateEditor
        templateKey={key}
        kind={isSystem ? "system" : "custom"}
        displayName={displayName}
        templates={switcherOptions}
        versions={versions}
        activeVersion={activeVersion}
        initialHtml={initialHtml}
      />
    </div>
  );
}
