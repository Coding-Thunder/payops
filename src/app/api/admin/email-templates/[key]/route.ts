import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { ServiceTypeLabel } from "@/lib/constants/labels";
import { ValidationError } from "@/lib/errors";
import {
  createEmailTemplateVersionSchema,
  emailServiceTypeSchema,
  templateKeyParam,
} from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { getSelectedOrganization } from "@/server/auth/organization";
import { requirePermission } from "@/server/auth/session";
import { previewServicesFor } from "@/server/email/preview";
import {
  createTemplateVersion,
  listTemplateVersions,
} from "@/server/services/email-template.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ key: string }>;
}

/** List the versions (by version desc) for `[key]` — one service's with
 *  `?serviceType=`, every service's without. */
export const GET = withApi(async (req: NextRequest, { params }: Params) => {
  await requirePermission(Permission.EMAIL_TEMPLATE_VIEW);
  const { key } = await params;
  const templateKey = templateKeyParam.parse(key);
  const requested = new URL(req.url).searchParams.get("serviceType");
  const versions = await listTemplateVersions(
    templateKey,
    requested ? emailServiceTypeSchema.parse(requested) : undefined,
  );
  return jsonOk({ versions });
});

/**
 * Create a new immutable version + activate it — for ONE service
 * (`serviceType`, required): copy is per service, so a car rental's wording
 * can never reach a flight or hotel email. Only a service the selected
 * organization sells.
 */
export const POST = withApi(async (req: NextRequest, { params }: Params) => {
  const actor = await requirePermission(Permission.EMAIL_TEMPLATE_MANAGE);
  const { key } = await params;
  const templateKey = templateKeyParam.parse(key);
  const body = await req.json().catch(() => ({}));
  const input = createEmailTemplateVersionSchema.parse(body);
  const serviceType = emailServiceTypeSchema.parse(body?.serviceType);
  const organization = await getSelectedOrganization();
  if (!(await previewServicesFor(organization?.id ?? null)).includes(serviceType)) {
    throw new ValidationError(
      `${organization?.brandName ?? "This organization"} does not sell ${ServiceTypeLabel[serviceType].toLowerCase()}, so it has no ${ServiceTypeLabel[serviceType].toLowerCase()} email copy to save.`,
    );
  }
  const ctx = await getRequestContext();
  const version = await createTemplateVersion(
    templateKey,
    input,
    { actor, request: ctx },
    serviceType,
  );
  return jsonOk(version, { status: 201 });
});
