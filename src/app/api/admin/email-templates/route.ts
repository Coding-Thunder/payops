import type { NextRequest } from "next/server";

import { ForbiddenError } from "@/lib/errors";
import { Permission } from "@/lib/constants/permissions";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { listAllTemplatesSummary } from "@/server/services/email-template.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Summary list of every template (system + custom) available to this
 * tenant. Drives the admin template list and the "Send a template"
 * picker on order / customer / payment surfaces.
 *
 * System rows always surface so an operator can dispatch a payment
 * request ad-hoc; custom rows surface only when the tenant has saved
 * an active version.
 */
export const GET = withApi(async (_req: NextRequest) => {
  const actor = await requirePermission(Permission.EMAIL_TEMPLATE_VIEW);
  if (!actor.orgId) throw new ForbiddenError("Active organization required");
  const templates = await listAllTemplatesSummary(actor.orgId);
  return jsonOk({ templates });
});
