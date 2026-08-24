import "server-only";

import { Types } from "mongoose";

import { RecordState } from "@/lib/constants/enums";
import { Organization, type OrganizationDoc } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import type { OrganizationScopeInput } from "@/server/db/organization-filter";
import type { OrganizationSummary } from "@/types";


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

/* ──────────────────── the single organization ───────────────────────── */

/**
 * Himanshu's deployment serves exactly ONE organization, and this is how
 * every path finds it.
 *
 * It replaces a cookie. That matters for more than tidiness: the cookie only
 * exists inside a browser request, so `getRequestOrganizationScope` returned
 * "no tenant" on every webhook delivery, every outbox drain and every public
 * consent or acknowledgement submission. Rows written from those paths were
 * stamped `organizationId: null` and stayed visible only because the
 * singleton carries `isDefault: true`, which makes the scope clause include
 * unattributed rows. Resolving server-side means those records are now
 * attributed correctly, which is what "every record must be unambiguously
 * associated with the organization" actually requires.
 *
 * Memoised for the life of the process, not the request — one organization
 * does not change between requests, and this is on the payment-link and
 * webhook hot paths. ONLY a successful lookup is cached: memoising a miss on
 * a not-yet-seeded database would make the process serve errors until it is
 * restarted.
 */
let cachedOrganization: OrganizationSummary | null = null;

/** Test seam — the suite seeds a fresh organization per file. */
export function _resetOrganizationCacheForTests(): void {
  cachedOrganization = null;
}

export async function getOrganization(): Promise<OrganizationSummary> {
  if (cachedOrganization) return cachedOrganization;

  await connectMongo();
  const doc = await Organization.findOne({ status: RecordState.ACTIVE })
    .sort({ isDefault: -1, createdAt: 1 })
    .select("slug name brandName")
    .lean<
      (Pick<OrganizationDoc, "slug" | "name" | "brandName"> & {
        _id: Types.ObjectId;
      }) | null
    >();

  if (!doc) {
    // A single-tenant deployment with no tenant is a misconfiguration, not a
    // state to quietly serve empty pages from. Loud beats blank.
    throw new Error(
      "No organization is seeded. Run `npm run seed:orgs` before starting the application.",
    );
  }

  cachedOrganization = toSummary(doc);
  return cachedOrganization;
}

/** The organization id, for the many callers that only need to stamp it. */
export async function resolveOrganizationId(): Promise<string> {
  return (await getOrganization()).id;
}

/**
 * The tenancy scope for any code path, browser request or not.
 *
 * One organization means one answer, so this no longer depends on a cookie,
 * a membership lookup, or whether a request store exists at all. That last
 * part is the substantive change: the previous resolver returned "no tenant"
 * outside a request, so webhook deliveries, outbox drains and public consent
 * submissions all wrote `organizationId: null`.
 *
 * `isDefault: true` is deliberate and load-bearing. It makes
 * `organizationScopeClause` match unattributed rows as well as stamped ones,
 * which keeps history written before this change visible — including the four
 * scoped collections nothing has ever stamped (disputes, quotations,
 * pending_emails, processed_webhook_events). Setting it false would silently
 * empty those.
 */
export async function getRequestOrganizationScope(): Promise<OrganizationScopeInput> {
  return { organizationId: await resolveOrganizationId(), isDefault: true };
}
