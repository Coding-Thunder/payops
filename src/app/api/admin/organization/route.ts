import type { NextRequest } from "next/server";
import { z } from "zod";

import { Permission } from "@/lib/constants/permissions";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import {
  getOrganization,
  renameOrganization,
} from "@/server/services/organization.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const renameSchema = z.object({
  name: z.string().trim().min(1).max(120),
});

/** GET /api/admin/organization — return the current org. */
export const GET = withApi(async () => {
  const actor = await requirePermission(Permission.SETTINGS_VIEW);
  if (!actor.orgId) {
    throw new Error("Your account is not attached to an organization.");
  }
  const org = await getOrganization(actor.orgId);
  return jsonOk({ organization: org });
});

/** PATCH /api/admin/organization — rename. Slug is intentionally
 *  immutable post-creation. */
export const PATCH = withApi(async (req: NextRequest) => {
  const actor = await requirePermission(Permission.SETTINGS_UPDATE);
  if (!actor.orgId) {
    throw new Error("Your account is not attached to an organization.");
  }
  const body = renameSchema.parse(await req.json());
  const ctx = await getRequestContext();
  const updated = await renameOrganization(
    actor.orgId,
    { name: body.name },
    {
      actor: { id: actor.id, name: actor.name, role: actor.role },
      request: ctx,
    },
  );
  return jsonOk({ organization: updated });
});
