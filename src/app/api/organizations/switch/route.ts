import type { NextRequest } from "next/server";
import { z } from "zod";

import { jsonOk, withApi } from "@/server/api/respond";
import {
  assertOrganizationAccess,
  listMemberOrganizations,
} from "@/server/auth/organization";
import { setSelectedOrgCookie } from "@/server/auth/org-cookie";
import { requireUser } from "@/server/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const switchSchema = z.object({
  organizationId: z.string().regex(/^[a-f0-9]{24}$/i, "Invalid organization"),
});

/**
 * Switch which organization the operator is acting in.
 *
 * THE SUPPLIED ID IS NEVER TRUSTED. `assertOrganizationAccess` re-resolves it
 * against the caller's own ACTIVE `OrganizationMember` rows and throws a flat
 * Forbidden for anything else — the same message whether the organization
 * does not exist, is disabled, or simply is not theirs, so this cannot be
 * used to enumerate organization ids.
 *
 * Only after that check is the selection cookie written, and even then the
 * cookie remains a hint: every subsequent request re-validates it against
 * membership. Setting the cookie grants nothing on its own.
 *
 * A user who belongs to exactly one organization never needs this route —
 * their organization is auto-selected — so a single-brand deployment behaves
 * exactly as it does today whether or not this endpoint exists.
 */
export const POST = withApi(async (req: NextRequest) => {
  await requireUser();
  const { organizationId } = switchSchema.parse(await req.json());

  // Authorization first. Throws ForbiddenError if this user may not act here.
  const organization = await assertOrganizationAccess(organizationId);

  await setSelectedOrgCookie(organization.id);

  return jsonOk({
    selected: organization,
    organizations: await listMemberOrganizations(),
  });
});
