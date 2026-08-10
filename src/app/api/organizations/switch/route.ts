import type { NextRequest, NextResponse } from "next/server";

import { switchOrganizationSchema } from "@/lib/validation";
import { jsonOk, withApi } from "@/server/api/respond";
import { assertOrganizationAccess } from "@/server/auth/organization";
import { setSelectedOrgCookie } from "@/server/auth/org-cookie";
import { requireUser } from "@/server/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/organizations/switch — choose the organization to act in.
 *
 * This is the only place the selection cookie is written, and it is a Route
 * Handler for a hard reason rather than a stylistic one: since Next 16,
 * cookies may only be mutated in the "action" request phase (Route
 * Handlers, Server Functions, proxy). A Server Component render cannot set
 * a cookie, so the layout is physically unable to quietly default a
 * selection on the user's behalf — which is exactly the property we want.
 *
 * `assertOrganizationAccess` runs BEFORE the cookie is written, so an id
 * the caller is not a member of never reaches the browser. Being refused
 * leaves any previous valid selection untouched.
 */
export const POST = withApi(
  async (req: NextRequest) => {
    await requireUser();
    const body = await req.json();
    const { organizationId } = switchOrganizationSchema.parse(body);

    // Throws ForbiddenError unless this is one of the caller's own ACTIVE
    // memberships. Never trust the id on the wire.
    const org = await assertOrganizationAccess(organizationId);

    await setSelectedOrgCookie(org.id);
    return jsonOk(org) as NextResponse;
  },
  {
    bodyLimitBytes: 1024,
  },
);
