import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { resetUserPasswordSchema } from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { resetUserPassword } from "@/server/services/user.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

export const POST = withApi(async (req: NextRequest, { params }: Params) => {
  const actor = await requirePermission(Permission.USER_RESET_PASSWORD);
  const { id } = await params;
  const body = await req.json();
  const input = resetUserPasswordSchema.parse(body);
  const ctx = await getRequestContext();
  await resetUserPassword(id, input, { actor, request: ctx });
  return jsonOk({ reset: true });
});
