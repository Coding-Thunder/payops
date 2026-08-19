import type { NextRequest } from "next/server";
import { z } from "zod";

import { getAdminEmail } from "@/console/server/auth/session";
import { getUserGuardInfo } from "@/console/server/services/users";
import {
  impersonationEnabled,
  impersonationStartUrl,
  signImpersonationToken,
} from "@/console/server/services/impersonation";
import { recordAdminAction } from "@/console/server/audit";
import { assertSameOrigin, jsonError, jsonOk, clientIp } from "@/console/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ userId: z.string().min(1).max(64) });

/**
 * Mint a single-use impersonation handoff for a target user. Observe-only
 * is forced (the approved default) — the minted main-app session blocks all
 * mutations. Returns a redirect URL into the main app's start route.
 */
export async function POST(req: NextRequest) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;

  const admin = await getAdminEmail();
  if (!admin) return jsonError(401, "UNAUTHORIZED", "Unauthorized");
  if (!impersonationEnabled()) {
    return jsonError(503, "DISABLED", "Impersonation is not configured");
  }

  const body = await req.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) return jsonError(422, "VALIDATION_ERROR", "A userId is required");

  // Confirm the target exists before minting anything.
  const guard = await getUserGuardInfo(parsed.data.userId);
  if (!guard) return jsonError(404, "NOT_FOUND", "User not found");

  const token = await signImpersonationToken({
    targetUserId: parsed.data.userId,
    by: admin,
    observeOnly: true,
  });
  if (!token) return jsonError(503, "DISABLED", "Impersonation is not configured");

  await recordAdminAction({
    action: "user.impersonate",
    actorEmail: admin,
    targetType: "user",
    targetId: parsed.data.userId,
    metadata: { observeOnly: true, target: guard.email },
    ip: clientIp(req),
  });

  return jsonOk({ url: impersonationStartUrl(token) });
}
