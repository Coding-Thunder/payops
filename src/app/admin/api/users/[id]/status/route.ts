import type { NextRequest } from "next/server";
import { z } from "zod";

import { getAdminEmail } from "@/console/server/auth/session";
import { normalizeEmail } from "@/console/server/auth/allowlist";
import { getUserGuardInfo, setUserStatus } from "@/console/server/services/users";
import { recordAdminAction } from "@/console/server/audit";
import { assertSameOrigin, jsonError, jsonOk, clientIp } from "@/console/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ status: z.enum(["ACTIVE", "DISABLED"]) });

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;

  const admin = await getAdminEmail();
  if (!admin) return jsonError(401, "UNAUTHORIZED", "Unauthorized");

  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) return jsonError(422, "VALIDATION_ERROR", "status must be ACTIVE or DISABLED");

  // Owner + self protection on the destructive direction. Disabling
  // yourself would lock you out of the console; disabling an org owner
  // would lock every member out of that tenant.
  if (parsed.data.status === "DISABLED") {
    const guard = await getUserGuardInfo(id);
    if (!guard) return jsonError(404, "NOT_FOUND", "User not found");
    if (normalizeEmail(guard.email) === normalizeEmail(admin)) {
      return jsonError(409, "SELF_PROTECT", "You can't disable your own account");
    }
    if (guard.isOrgOwner) {
      return jsonError(409, "OWNER_PROTECT", "This user owns an organization — disabling them would lock out that tenant. Transfer ownership first.");
    }
  }

  const next = await setUserStatus(id, parsed.data.status);
  if (!next) return jsonError(404, "NOT_FOUND", "User not found");

  await recordAdminAction({
    action: "user.set_status",
    actorEmail: admin,
    targetType: "user",
    targetId: id,
    metadata: { status: next },
    ip: clientIp(req),
  });
  return jsonOk({ status: next });
}
