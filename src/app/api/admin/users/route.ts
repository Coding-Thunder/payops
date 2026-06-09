import type { NextRequest } from "next/server";

import { ForbiddenError } from "@/lib/errors";
import { Permission } from "@/lib/constants/permissions";
import { createUserSchema, listUsersQuerySchema } from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { createUser, listUsers } from "@/server/services/user.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi(async (req: NextRequest) => {
  const actor = await requirePermission(Permission.USER_VIEW);
  if (!actor.orgId) throw new ForbiddenError("Active organization required");
  const url = new URL(req.url);
  const query = listUsersQuerySchema.parse(
    Object.fromEntries(url.searchParams.entries()),
  );
  const data = await listUsers(query, { orgId: actor.orgId });
  return jsonOk(data);
});

export const POST = withApi(async (req: NextRequest) => {
  const actor = await requirePermission(Permission.USER_CREATE);
  if (!actor.orgId) throw new ForbiddenError("Active organization required");
  const body = await req.json();
  const input = createUserSchema.parse(body);
  const ctx = await getRequestContext();
  const data = await createUser(input, {
    actor,
    orgId: actor.orgId,
    request: ctx,
  });
  return jsonOk(data, { status: 201 });
});
