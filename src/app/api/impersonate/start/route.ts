import { NextResponse, type NextRequest } from "next/server";

import { AuditAction, AuditEntity, type UserRole } from "@/lib/constants/enums";
import { getRequestContext } from "@/server/api/request-context";
import { setSessionCookie } from "@/server/auth/cookies";
import { signSession } from "@/server/auth/jwt";
import { User } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import { recordAudit } from "@/server/services/audit.service";
import { verifyAndConsumeImpersonationToken } from "@/server/services/impersonation.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Impersonation sessions are deliberately short — 30 minutes. */
const IMPERSONATION_TTL_SECONDS = 30 * 60;

/**
 * Founder-console impersonation handoff. Public (no session): the console
 * operator has no session on this app; the single-use token is the
 * credential and is verified + burned before anything is minted.
 *
 * On success mints a SHORT-TTL session for the target user carrying the
 * `imp` claim (so the proxy blocks mutations in observe-only mode and the
 * shell shows a persistent banner), writes an audit row attributed to the
 * operator, and redirects into the app. Any failure lands on /login.
 */
export async function GET(req: NextRequest) {
  const token = new URL(req.url).searchParams.get("token") ?? "";
  const grant = await verifyAndConsumeImpersonationToken(token);
  if (!grant) {
    return NextResponse.redirect(new URL("/login?error=impersonation", req.url));
  }

  await connectMongo();
  const target = await User.findById(grant.targetUserId).lean<{
    _id: unknown;
    name: string;
    email: string;
    role: UserRole;
    status: string;
    primaryOrgId?: unknown;
  } | null>();
  if (!target || target.status !== "ACTIVE") {
    return NextResponse.redirect(
      new URL("/login?error=impersonation_target", req.url),
    );
  }

  const orgId = target.primaryOrgId ? String(target.primaryOrgId) : undefined;
  const sessionToken = await signSession(
    {
      sub: String(target._id),
      email: target.email,
      name: target.name,
      role: target.role,
      orgId,
      imp: { by: grant.by, obs: grant.observeOnly },
    },
    IMPERSONATION_TTL_SECONDS,
  );
  await setSessionCookie(sessionToken, {
    maxAgeSeconds: IMPERSONATION_TTL_SECONDS,
  });

  // Audit: actor = the platform operator (not a main-app user); entity =
  // the impersonated user. Best-effort — never block the handoff.
  const request = await getRequestContext();
  await recordAudit({
    action: AuditAction.USER_IMPERSONATED,
    entityType: AuditEntity.USER,
    entityId: String(target._id),
    orgId: orgId ?? null,
    actor: { userId: null, name: grant.by, email: grant.by, role: null },
    request,
    metadata: {
      observeOnly: grant.observeOnly,
      impersonatedEmail: target.email,
    },
  });

  return NextResponse.redirect(new URL("/app/dashboard", req.url));
}
