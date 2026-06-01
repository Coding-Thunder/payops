import type { NextRequest } from "next/server";

import { ForbiddenError } from "@/lib/errors";
import { Permission } from "@/lib/constants/permissions";
import { createCustomTemplateSchema } from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { createCustomTemplate } from "@/server/services/email-template.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Create a brand-new custom (tenant-defined) email template. Writes
 * the first version with kind=custom, stamps displayName, and lights
 * it up as active immediately so it shows in the picker right away.
 *
 * Subsequent edits use the existing POST /api/admin/email-templates/[key]
 * path (which is shared with system kinds).
 */
export const POST = withApi(async (req: NextRequest) => {
  const actor = await requirePermission(Permission.EMAIL_TEMPLATE_MANAGE);
  if (!actor.orgId) throw new ForbiddenError("Active organization required");
  const body = await req.json().catch(() => ({}));
  const input = createCustomTemplateSchema.parse(body);
  const ctx = await getRequestContext();
  const template = await createCustomTemplate(input, {
    actor,
    orgId: actor.orgId,
    request: ctx,
  });
  return jsonOk(template, { status: 201 });
});
