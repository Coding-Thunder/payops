import type { NextRequest } from "next/server";

import { updateMemberPermissionsSchema } from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requireOwner } from "@/server/auth/session";
import { setMemberPermissions } from "@/server/services/user.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * PATCH /api/admin/users/[id]/permissions — OWNER-only.
 *
 * A SEPARATE route from PATCH /api/admin/users/[id] (name/role/status,
 * USER_UPDATE) precisely so the actor gate is workspaceRole === "OWNER"
 * (requireOwner) rather than the mutable USER_UPDATE membership. The
 * service intersects custom grants with the member-eligible allow-list, so
 * a restricted key can never be persisted even if it slips past the schema.
 */
export const PATCH = withApi(async (req: NextRequest, { params }: Params) => {
  const actor = await requireOwner();
  const { id } = await params;
  const input = updateMemberPermissionsSchema.parse(await req.json());
  const ctx = await getRequestContext();
  const data = await setMemberPermissions(id, input, {
    actor,
    orgId: actor.orgId,
    request: ctx,
  });
  return jsonOk(data);
});
