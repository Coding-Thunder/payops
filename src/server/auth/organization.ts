import "server-only";

import { cache } from "react";
import { Types } from "mongoose";

import { RecordState, UserRole } from "@/lib/constants/enums";
import { ForbiddenError } from "@/lib/errors";
import {
  Organization,
  OrganizationMember,
  type OrganizationDoc,
} from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import type { OrganizationSummary } from "@/types";

import { readSelectedOrgCookie } from "./org-cookie";
import { getCurrentUser } from "./session";

/**
 * Resolving "which organization is this request acting in".
 *
 * The contract, in order of precedence:
 *
 *   1. The selected-org cookie names an organization.
 *   2. That organization is ACTIVE.
 *   3. The authenticated user has an ACTIVE membership row for it.
 *
 * All three must hold. Anything else resolves to `null` — no implicit
 * default, no "first organization we found", no falling back to the flag on
 * the organization document. A cookie is a hint; the membership row is the
 * authority. This is what makes a forged or copied cookie useless.
 *
 * BACKWARD COMPATIBILITY, and the reason this can ship before anything is
 * migrated: while the organizations collection is EMPTY the entire layer is
 * inert. `organizationsExist()` is false, the shell renders no switcher, no
 * route redirects, and every existing workflow behaves exactly as it does
 * today. The layer only becomes visible once an operator runs the seed —
 * which is the explicit opt-in moment.
 *
 * Membership is required for every role, SUPER_ADMIN included. Letting a
 * global role bypass the check would make "prevent cross-organization
 * access" untrue for the exact account most likely to be automated against.
 * The cost is that creating an organization must also create a membership;
 * the seed and the P7 organization both do.
 */

/** Re-exported for server callers so they need only one import. The shape
 *  itself lives in `@/types` because client components consume it too. */
export type { OrganizationSummary };

function toSummary(
  doc: Pick<OrganizationDoc, "slug" | "name" | "brandName"> & {
    _id: Types.ObjectId;
  },
): OrganizationSummary {
  return {
    id: String(doc._id),
    slug: doc.slug,
    name: doc.name,
    brandName: doc.brandName,
  };
}

/**
 * Whether this deployment has been migrated to organizations at all.
 *
 * Cached per request: it is consulted by the layout, the page, and the
 * guard, and an uncached count would be three round trips on every render.
 */
export const organizationsExist = cache(async (): Promise<boolean> => {
  await connectMongo();
  const n = await Organization.countDocuments({}).limit(1);
  return n > 0;
});

/**
 * Organizations the signed-in user may act in, ordered for a stable
 * switcher. Empty when unauthenticated or when the user has no memberships.
 */
export const listMemberOrganizations = cache(
  async (): Promise<OrganizationSummary[]> => {
    const user = await getCurrentUser();
    if (!user) return [];

    await connectMongo();
    const memberships = await OrganizationMember.find({
      userId: new Types.ObjectId(user.id),
      status: RecordState.ACTIVE,
    })
      .select("organizationId")
      .lean<{ organizationId: Types.ObjectId }[]>();

    if (memberships.length === 0) return [];

    const orgs = await Organization.find({
      _id: { $in: memberships.map((m) => m.organizationId) },
      status: RecordState.ACTIVE,
    })
      .sort({ name: 1 })
      .select("slug name brandName")
      .lean<
        (Pick<OrganizationDoc, "slug" | "name" | "brandName"> & {
          _id: Types.ObjectId;
        })[]
      >();

    return orgs.map(toSummary);
  },
);

/**
 * The organization this request is acting in, or null if the user has not
 * chosen one (or chose one they may no longer use).
 */
export const getSelectedOrganization = cache(
  async (): Promise<OrganizationSummary | null> => {
    const selectedId = await readSelectedOrgCookie();
    if (!selectedId || !Types.ObjectId.isValid(selectedId)) return null;

    // Re-resolve against the user's live memberships rather than trusting
    // the cookie. Reusing the cached list keeps this to zero extra queries
    // on a request that already rendered the switcher.
    const allowed = await listMemberOrganizations();
    return allowed.find((o) => o.id === selectedId) ?? null;
  },
);

/**
 * The organization, or a refusal. For server code that must not proceed
 * without an explicit selection.
 */
export async function requireOrganization(): Promise<OrganizationSummary> {
  const org = await getSelectedOrganization();
  if (!org) {
    throw new ForbiddenError("Select an organization to continue");
  }
  return org;
}

/**
 * Authorize a specific organization id for the signed-in user.
 *
 * This is the function API routes call when an organization id arrives from
 * the client. It never trusts the supplied id: it is only accepted if it
 * matches one of the caller's own ACTIVE memberships.
 */
export async function assertOrganizationAccess(
  organizationId: string,
): Promise<OrganizationSummary> {
  if (!Types.ObjectId.isValid(organizationId)) {
    throw new ForbiddenError("You do not have access to that organization");
  }
  const allowed = await listMemberOrganizations();
  const match = allowed.find((o) => o.id === organizationId);
  if (!match) {
    // Deliberately the same message whether the organization does not
    // exist, is disabled, or simply is not theirs — otherwise this becomes
    // an oracle for enumerating organization ids.
    throw new ForbiddenError("You do not have access to that organization");
  }
  return match;
}

/** The caller's role *within* an organization, which may differ from their
 *  global `User.role`. Null when they are not a member. */
export async function getOrganizationRole(
  organizationId: string,
): Promise<UserRole | null> {
  const user = await getCurrentUser();
  if (!user || !Types.ObjectId.isValid(organizationId)) return null;
  await connectMongo();
  const row = await OrganizationMember.findOne({
    organizationId: new Types.ObjectId(organizationId),
    userId: new Types.ObjectId(user.id),
    status: RecordState.ACTIVE,
  })
    .select("role")
    .lean<{ role: UserRole } | null>();
  return row?.role ?? null;
}
