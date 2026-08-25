import type { NextRequest } from "next/server";

import { isSystemTemplateKey } from "@/lib/constants/email-templates";
import { Permission } from "@/lib/constants/permissions";
import {
  createEmailTemplateVersionSchema,
  templateKeyParam,
} from "@/lib/validation";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { listAllTemplatesSummary } from "@/server/services/email-template.service";
import { renderTemplatePreview } from "@/server/services/template-preview.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ key: string }>;
}

/**
 * Render the chosen template with the editor's current draft, without
 * saving anything. Powers the editor's live preview pane.
 *
 * THE BUG THIS FIXES: this endpoint used to branch on
 * `templateKey === "payment-request"` and send everything else — every
 * custom template a tenant had ever written — down an `else` that
 * rendered the Payment Confirmation layout from canned payment data and
 * discarded the draft entirely. Selecting "Meeting Time" and typing into
 * it produced a Payment Receipt with an Amount Paid and a Total.
 *
 * The renderer now lives in `template-preview.service`, shared with the
 * editor page's server-side first paint, so the selected template drives
 * the layout on both and they cannot disagree.
 */
export const POST = withApi(
  async (req: NextRequest, { params }: Params) => {
    const actor = await requirePermission(Permission.EMAIL_TEMPLATE_VIEW);
    const { key } = await params;
    const templateKey = templateKeyParam.parse(key);

    const body = await req.json().catch(() => ({}));
    const draft = createEmailTemplateVersionSchema.parse({
      subject: body?.subject,
      body: body?.body,
      greeting: body?.greeting,
      intro: body?.intro,
      note: body?.note,
      supportHeadline: body?.supportHeadline,
      supportDescription: body?.supportDescription,
      footerNote: body?.footerNote,
    });

    // Custom kinds put their operator-given name in the eyebrow, so the
    // preview is identifiably THIS template rather than a generic shell.
    let displayName = templateKey;
    if (!isSystemTemplateKey(templateKey) && actor.orgId) {
      const summaries = await listAllTemplatesSummary(actor.orgId);
      displayName =
        summaries.find((s) => s.templateKey === templateKey)?.displayName ??
        templateKey;
    }

    const html = await renderTemplatePreview({
      templateKey,
      displayName,
      draft,
      // CRITICAL: pass actor.orgId so the preview reads THIS tenant's
      // branding + settings, not the legacy {key:"default"} singleton
      // seeded from platform env defaults. Omitting it here was the bug
      // that made the pane flicker from the tenant brand (SSR'd with an
      // orgId) to the platform defaults (this endpoint, without one).
      orgId: actor.orgId,
    });
    return jsonOk({ html });
  },
  {
    // A written body runs to 20k characters; the default 32 KB JSON cap
    // would start rejecting long drafts mid-typing.
    bodyLimitBytes: 256 * 1024,
  },
);
