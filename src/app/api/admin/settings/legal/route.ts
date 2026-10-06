import type { NextRequest } from "next/server";
import { z } from "zod";

import { ServiceType } from "@/lib/constants/enums";
import { Permission } from "@/lib/constants/permissions";
import { SERVICE_LEGAL_TYPES, updateServiceLegalSchema } from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requireOrganization } from "@/server/auth/organization";
import { requirePermission } from "@/server/auth/session";
import {
  getOrganizationServiceLegal,
  updateOrganizationServiceLegal,
} from "@/server/services/organization-legal.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `?serviceType=` — FLIGHT when absent, which is what this route served
 *  before hotel terms existed. */
const serviceTypeQuery = z
  .enum(SERVICE_LEGAL_TYPES)
  .default(ServiceType.FLIGHT);

/**
 * The selected organization's flight or hotel terms (Admin → Settings).
 *
 * Unlike `/api/admin/settings`, which edits the deployment-wide singleton,
 * this is scoped to ONE organization — always the one in the validated
 * selected-org cookie. No organization id is read from the request, so a
 * body or query string cannot point it at another brand. Both methods
 * refuse a service that organization does not sell.
 */
export const GET = withApi(async (req?: NextRequest) => {
  await requirePermission(Permission.SETTINGS_VIEW);
  const organization = await requireOrganization();
  const serviceType = serviceTypeQuery.parse(
    (req ? new URL(req.url).searchParams.get("serviceType") : null) ??
      undefined,
  );
  const data = await getOrganizationServiceLegal(organization.id, serviceType);
  return jsonOk(data);
});

export const PATCH = withApi(async (req: NextRequest) => {
  const actor = await requirePermission(Permission.SETTINGS_UPDATE);
  const body = await req.json();
  const input = updateServiceLegalSchema.parse(body);
  const ctx = await getRequestContext();
  const data = await updateOrganizationServiceLegal(input, {
    actorId: actor.id,
    actorName: actor.name,
    actorRole: actor.role,
    request: ctx,
  });
  return jsonOk(data);
});
