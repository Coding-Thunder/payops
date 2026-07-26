import { NextResponse } from "next/server";

import { AuditAction, AuditEntity } from "@/lib/constants/enums";
import { getRequestContext } from "@/server/api/request-context";
import { clearSessionCookie } from "@/server/auth/cookies";
import { getCurrentUser } from "@/server/auth/session";
import { recordAudit } from "@/server/services/audit.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * End an impersonation session. Clears the session cookie (the operator
 * had no long-lived session here — they return to the console). Audits the
 * end only when the current session actually WAS an impersonation. Allowed
 * through the proxy's observe-only mutation block so an operator can always
 * escape. SameSite=strict + the fact this only logs out makes CSRF a
 * non-issue.
 */
export async function POST() {
  const user = await getCurrentUser();
  await clearSessionCookie();

  if (user?.impersonation) {
    const request = await getRequestContext();
    await recordAudit({
      action: AuditAction.USER_IMPERSONATION_ENDED,
      entityType: AuditEntity.USER,
      entityId: user.id,
      orgId: user.orgId ?? null,
      actor: {
        userId: null,
        name: user.impersonation.by,
        email: user.impersonation.by,
        role: null,
      },
      request,
      metadata: { impersonatedEmail: user.email },
    });
  }

  return NextResponse.json({ ok: true });
}
