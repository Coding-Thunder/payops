import type { NextRequest } from "next/server";

import { updateAccountSchema } from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requireUser } from "@/server/auth/session";
import { updateOwnName } from "@/server/services/user.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PATCH /api/account — self-serve. Any authenticated user (owner or member)
 * may change ONLY their own display name. The service takes the target id
 * from the session actor, never from the body, so this cannot touch another
 * user or escalate role/status.
 */
export const PATCH = withApi(async (req: NextRequest) => {
  const actor = await requireUser();
  const input = updateAccountSchema.parse(await req.json());
  const ctx = await getRequestContext();
  const data = await updateOwnName(input, { actor, request: ctx });
  return jsonOk(data);
});
