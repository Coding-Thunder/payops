import type { NextRequest } from "next/server";

import { ForbiddenError } from "@/lib/errors";
import { Permission } from "@/lib/constants/permissions";
import {
  createEmailTemplateVersionSchema,
  templateKeyParam,
} from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import {
  archiveCustomTemplate,
  createTemplateVersion,
  listTemplateVersions,
} from "@/server/services/email-template.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ key: string }>;
}

/** List every version (active first by version desc) for `[key]`. */
export const GET = withApi(async (_req: NextRequest, { params }: Params) => {
  const actor = await requirePermission(Permission.EMAIL_TEMPLATE_VIEW);
  const { key } = await params;
  const templateKey = templateKeyParam.parse(key);
  // Phase 3d: scope to actor's org so Tenant #2 sees only their own
  // version history (empty until they save the first override).
  const versions = await listTemplateVersions(templateKey, actor.orgId);
  return jsonOk({ versions });
});

/** Create a new immutable version + activate it. */
export const POST = withApi(async (req: NextRequest, { params }: Params) => {
  const actor = await requirePermission(Permission.EMAIL_TEMPLATE_MANAGE);
  const { key } = await params;
  const templateKey = templateKeyParam.parse(key);
  const body = await req.json().catch(() => ({}));
  const input = createEmailTemplateVersionSchema.parse(body);
  const ctx = await getRequestContext();
  const version = await createTemplateVersion(templateKey, input, {
    actor,
    orgId: actor.orgId,
    request: ctx,
  });
  return jsonOk(version, { status: 201 });
});

/** Archive a custom template. Soft-delete; the rows stay for audit +
 *  future trigger replay but the template stops appearing in pickers.
 *  Service refuses if `templateKey` is a system kind. */
export const DELETE = withApi(async (_req: NextRequest, { params }: Params) => {
  const actor = await requirePermission(Permission.EMAIL_TEMPLATE_MANAGE);
  if (!actor.orgId) throw new ForbiddenError("Active organization required");
  const { key } = await params;
  const templateKey = templateKeyParam.parse(key);
  const ctx = await getRequestContext();
  await archiveCustomTemplate(templateKey, {
    actor,
    orgId: actor.orgId,
    request: ctx,
  });
  return jsonOk({ archived: true });
});
