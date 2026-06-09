import type { NextRequest } from "next/server";

import { ForbiddenError } from "@/lib/errors";
import { Permission } from "@/lib/constants/permissions";
import { updateUserSchema } from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { getUserById, updateUser } from "@/server/services/user.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

export const GET = withApi(async (_req: NextRequest, { params }: Params) => {
  const actor = await requirePermission(Permission.USER_VIEW);
  if (!actor.orgId) throw new ForbiddenError("Active organization required");
  const { id } = await params;
  const data = await getUserById(id, { orgId: actor.orgId });
  return jsonOk(data);
});

export const PATCH = withApi(async (req: NextRequest, { params }: Params) => {
  const actor = await requirePermission(Permission.USER_UPDATE);
  if (!actor.orgId) throw new ForbiddenError("Active organization required");
  const { id } = await params;
  const body = await req.json();
  const input = updateUserSchema.parse(body);
  const ctx = await getRequestContext();
  const data = await updateUser(id, input, {
    actor,
    orgId: actor.orgId,
    request: ctx,
  });
  return jsonOk(data);
});
