import type { NextRequest } from "next/server";

import { ForbiddenError } from "@/lib/errors";
import { Permission } from "@/lib/constants/permissions";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { resendTeamInvite } from "@/server/services/team-invite.service";
import { getUserById } from "@/server/services/user.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/admin/users/[id]/resend-invite — owner-only (USER_CREATE, which
 * is MEMBER_RESTRICTED). Regenerates the member's invite token (killing the
 * previously-emailed link) and re-sends the invitation. Org-scoped inside the
 * service (assertMember → 404 for another org's member) and rate-limited to
 * prevent email-bombing.
 */
export const POST = withApi(
  async (_req: NextRequest, { params }: Params) => {
    const actor = await requirePermission(Permission.USER_CREATE);
    if (!actor.orgId) throw new ForbiddenError("Active organization required");
    const { id } = await params;
    const ctx = await getRequestContext();
    await resendTeamInvite(id, {
      actor,
      orgId: actor.orgId,
      request: ctx,
    });
    const data = await getUserById(id, { orgId: actor.orgId });
    return jsonOk(data);
  },
  {
    rateLimit: { route: "team-invite-resend", max: 5, windowMs: 15 * 60_000 },
  },
);
