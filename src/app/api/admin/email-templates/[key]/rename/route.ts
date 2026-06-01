import type { NextRequest } from "next/server";

import { ForbiddenError } from "@/lib/errors";
import { Permission } from "@/lib/constants/permissions";
import {
  renameCustomTemplateSchema,
  templateKeyParam,
} from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { renameCustomTemplate } from "@/server/services/email-template.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ key: string }>;
}

/** Rename a custom template (displayName / description). Refuses on
 *  system templates — those are platform-named. */
export const PATCH = withApi(async (req: NextRequest, { params }: Params) => {
  const actor = await requirePermission(Permission.EMAIL_TEMPLATE_MANAGE);
  if (!actor.orgId) throw new ForbiddenError("Active organization required");
  const { key } = await params;
  const templateKey = templateKeyParam.parse(key);
  const body = await req.json().catch(() => ({}));
  const input = renameCustomTemplateSchema.parse(body);
  const ctx = await getRequestContext();
  const template = await renameCustomTemplate(templateKey, input, {
    actor,
    orgId: actor.orgId,
    request: ctx,
  });
  return jsonOk(template);
});
