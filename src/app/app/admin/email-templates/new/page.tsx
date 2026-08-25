import { notFound } from "next/navigation";

import { PageHeader } from "@/components/common/page-header";
import { AdminTemplateEditor } from "@/components/features/email-templates/admin-template-editor";
import { Permission } from "@/lib/constants/permissions";
import { requirePermission } from "@/server/auth/session";
import { renderTemplatePreview } from "@/server/services/template-preview.service";

export const metadata = { title: "New email template" };
export const dynamic = "force-dynamic";

/**
 * Create a custom template.
 *
 * The same editor as the edit page, in create mode — name, subject, the
 * email itself, live preview. There is no separate "set up the template"
 * step and no key to invent: the operator writes the email, presses
 * save, and lands in the editor for that template.
 */
export default async function NewEmailTemplatePage() {
  const user = await requirePermission(Permission.EMAIL_TEMPLATE_MANAGE);
  if (!user.orgId) notFound();

  const initialHtml = await renderTemplatePreview({
    templateKey: "draft-template",
    displayName: "New template",
    draft: {},
    orgId: user.orgId,
    placeholder:
      "Write your email on the left and it renders here, with sample client details filled in.",
  });

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Admin · Custom template"
        title="New template"
        description="Name it, write it, save it. Reuse it from any client — the details fill themselves in."
      />
      <AdminTemplateEditor
        kind="custom"
        displayName=""
        mode="create"
        initialHtml={initialHtml}
      />
    </div>
  );
}
