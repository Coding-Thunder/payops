import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { createUserSchema, listUsersQuerySchema } from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { createUser, listUsers } from "@/server/services/user.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi(async (req: NextRequest) => {
  await requirePermission(Permission.USER_VIEW);
  const url = new URL(req.url);
  const query = listUsersQuerySchema.parse(
    Object.fromEntries(url.searchParams.entries()),
  );
  const data = await listUsers(query);
  return jsonOk(data);
});

export const POST = withApi(async (req: NextRequest) => {
  const actor = await requirePermission(Permission.USER_CREATE);
  const body = await req.json();
  const input = createUserSchema.parse(body);
  const ctx = await getRequestContext();
  const data = await createUser(input, { actor, request: ctx });
  return jsonOk(data, { status: 201 });
});
