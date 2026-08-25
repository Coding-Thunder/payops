import type { NextRequest } from "next/server";
import { z } from "zod";

import { Permission } from "@/lib/constants/permissions";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { renderTemplatePreview } from "@/server/services/template-preview.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const draftSchema = z.object({
  displayName: z.string().trim().max(120).default("New template"),
  subject: z.string().trim().max(200).optional().nullable(),
  body: z.string().max(20_000).optional().nullable(),
});

/**
 * Preview a template that doesn't exist yet.
 *
 * The keyed endpoint needs a saved template to resolve a display name
 * and a kind. During creation there is neither — and making the operator
 * save a half-written template just to see it render is the setup step
 * this whole flow removes. Renders through the same shared renderer, so
 * the "New template" preview and the saved one are the same picture.
 */
export const POST = withApi(
  async (req: NextRequest) => {
    const actor = await requirePermission(Permission.EMAIL_TEMPLATE_MANAGE);
    const body = await req.json().catch(() => ({}));
    const draft = draftSchema.parse(body);

    const html = await renderTemplatePreview({
      // Any non-system key routes the renderer down the custom branch;
      // nothing is persisted, so the value itself is immaterial.
      templateKey: "draft-template",
      displayName: draft.displayName || "New template",
      draft: {
        subject: draft.subject ?? null,
        body: draft.body ?? null,
      },
      orgId: actor.orgId,
    });
    return jsonOk({ html });
  },
  { bodyLimitBytes: 256 * 1024 },
);
