import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { updateServiceLegalSchema } from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requireOrganization } from "@/server/auth/organization";
import { requirePermission } from "@/server/auth/session";
import {
  getOrganizationFlightLegal,
  updateOrganizationFlightLegal,
} from "@/server/services/organization-legal.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The selected organization's flight terms (Admin → Settings → Flight terms).
 *
 * Unlike `/api/admin/settings`, which edits the deployment-wide singleton,
 * this is scoped to ONE organization — always the one in the validated
 * selected-org cookie. No organization id is read from the request, so a
 * body or query string cannot point it at another brand.
 */
export const GET = withApi(async () => {
  await requirePermission(Permission.SETTINGS_VIEW);
  const organization = await requireOrganization();
  const data = await getOrganizationFlightLegal(organization.id);
  return jsonOk(data);
});

export const PATCH = withApi(async (req: NextRequest) => {
  const actor = await requirePermission(Permission.SETTINGS_UPDATE);
  const body = await req.json();
  const input = updateServiceLegalSchema.parse(body);
  const ctx = await getRequestContext();
  const data = await updateOrganizationFlightLegal(input, {
    actorId: actor.id,
    actorName: actor.name,
    actorRole: actor.role,
    request: ctx,
  });
  return jsonOk(data);
});
