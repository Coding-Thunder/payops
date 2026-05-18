import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import {
  createEmailTemplateVersionSchema,
  templateKeyParam,
} from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import {
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
  await requirePermission(Permission.EMAIL_TEMPLATE_VIEW);
  const { key } = await params;
  const templateKey = templateKeyParam.parse(key);
  const versions = await listTemplateVersions(templateKey);
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
    request: ctx,
  });
  return jsonOk(version, { status: 201 });
});
