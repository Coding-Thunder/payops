import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { cache } from "react";
import { Types } from "mongoose";

import { RecordState, ServiceType, UserRole } from "@/lib/constants/enums";
import { ForbiddenError } from "@/lib/errors";
import {
  Organization,
  OrganizationMember,
  type OrganizationDoc,
} from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import type { OrganizationScopeInput } from "@/server/db/organization-filter";
import type { OrganizationSummary } from "@/types";

import { readSelectedOrgCookie } from "./org-cookie";
import { getCurrentUser } from "./session";

/**
 * Resolving "which organization is this request acting in".
 *
 * This deployment serves MULTIPLE organizations out of ONE database with ONE
 * shared user pool — Himanshu (car rental) and RCR Cruise (flights, cruises)
 * today. Tenant data is isolated; user accounts are not duplicated.
 *
 * ═══ THE CONTRACT ═══════════════════════════════════════════════════════
 *
 * An organization is resolvable for a request only if ALL of these hold:
 *
 *   1. The user has an ACTIVE OrganizationMember row for it.
 *   2. The organization itself is ACTIVE.
 *   3. It survives the deployment pin (below), if one is configured.
 *
 * MEMBERSHIP IS THE AUTHORITY FOR EVERY ROLE, SUPER_ADMIN included. The
 * cookie is only a hint about which of the permitted organizations to act
 * in; a forged or copied cookie names an organization the user has no row
 * for and is discarded exactly like a random string.
 *
 * This deliberately DIVERGES from the `main` worktree, where ADMIN and
 * SUPER_ADMIN are granted every organization implicitly. That trade was
 * acceptable for a single operations team working all brands; it is not
 * acceptable here, because it would mean any admin credential reaches RCR
 * Cruise's live Stripe account. Global roles still carry their permissions
 * WITHIN an organization — they simply do not conjure membership of one.
 *
 * ═══ WHY HIMANSHU'S BEHAVIOUR IS UNCHANGED ══════════════════════════════
 *
 * Three compatibility rules, in the order they matter:
 *
 *   - ZERO organizations  → the layer is inert and every query is unscoped,
 *     exactly as before organizations existed.
 *   - ONE organization    → it is auto-selected. No cookie is needed, no
 *     switcher appears, and `getRequestOrganizationScope()` returns the same
 *     value it returns today. This is the state the live Himanshu database
 *     is in right now, so nothing about that deployment changes.
 *   - TWO OR MORE         → a selection is required. A request that has not
 *     proved which tenant it is acting as resolves to `denyAll` and sees
 *     NOTHING, rather than defaulting to somebody's data.
 *
 * `isDefault` is read from the organization document rather than assumed.
 * Only the default organization sees unattributed (`organizationId: null`)
 * history — that is what keeps Himanshu's pre-migration rows visible while
 * ensuring RCR Cruise can never inherit them.
 */

/** Re-exported for server callers so they need only one import. The shape
 *  itself lives in `@/types` because client components consume it too. */
export type { OrganizationSummary };

/* ─────────────────────────── projection ─────────────────────────── */

type OrganizationSummarySource = Pick<
  OrganizationDoc,
  "slug" | "name" | "brandName"
> & {
  _id: Types.ObjectId;
  isDefault?: boolean;
  /** Absent on a document seeded before service types existed. `.lean()`
   *  does not apply Mongoose defaults, so the fallback lives below. */
  serviceTypes?: ServiceType[];
};

const SUMMARY_FIELDS = "slug name brandName isDefault serviceTypes";

function toSummary(doc: OrganizationSummarySource): OrganizationSummary {
  return {
    id: String(doc._id),
    slug: doc.slug,
    name: doc.name,
    brandName: doc.brandName,
    isDefault: Boolean(doc.isDefault),
    // An organization seeded before this field existed sells car rental,
    // which is what it has always sold. Normalised here — once — so no
    // consumer has to remember the fallback.
    serviceTypes:
      doc.serviceTypes && doc.serviceTypes.length > 0
        ? doc.serviceTypes
        : [ServiceType.CAR_RENTAL],
  };
}

/* ──────────────────── explicit organization pinning ──────────────────── */

/**
 * An organization pinned for the duration of a callback.
 *
 * Webhook deliveries, the outbox drainer and CLI scripts have no session and
 * no cookie, but they absolutely do have a tenant — the one that owns the
 * order being settled or the row being written. Without this they would fall
 * through to "no selection" and stamp audit and evidence rows with the wrong
 * organization, or none at all.
 *
 * AsyncLocalStorage rather than a threaded argument because the consumers
 * (`recordAudit`, `captureEvidenceSafe`) are called many levels deep from
 * code that has no business knowing about tenancy. A missed argument would
 * be a silent mis-attribution; an ambient scope cannot be forgotten.
 */
const pinnedOrganization = new AsyncLocalStorage<OrganizationScopeInput>();

/**
 * Run `fn` with the organization scope pinned. Used by the per-organization
 * webhook routes so everything they write is attributed correctly.
 */
export function runWithOrganization<T>(
  scope: OrganizationScopeInput,
  fn: () => Promise<T>,
): Promise<T> {
  return pinnedOrganization.run(scope, fn);
}

/* ────────────────────────── deployment pin ────────────────────────── */

/**
 * Restrict this deployment to a single organization by slug.
 *
 * Set `PAYOPS_ORG_SLUG=himanshu` on the car-rental deployment and
 * `PAYOPS_ORG_SLUG=rcrcruise` on the RCR Cruise deployment, and each process
 * can only ever act as its own brand — a hard outer bound that holds even if
 * a cookie is wrong and even for a user who is a member of both.
 *
 * Left UNSET, the deployment serves every organization the signed-in user is
 * a member of and the switcher appears. Both modes are supported on purpose:
 * one deployment per brand is the safer production posture, while the
 * unpinned mode is what lets a dual-member operator work both tenants from
 * one console.
 *
 * The pin NARROWS; it never widens. A user with no membership of the pinned
 * organization is denied, not served.
 */
function deploymentPin(): string | null {
  const raw = process.env.PAYOPS_ORG_SLUG?.trim().toLowerCase();
  return raw ? raw : null;
}

/* ─────────────────────────── membership ─────────────────────────── */

/**
 * Whether this deployment has been migrated to organizations at all.
 *
 * Cached per request: it is consulted by the layout, the page and the scope
 * resolver, and an uncached count would be several round trips per render.
 */
export const organizationsExist = cache(async (): Promise<boolean> => {
  await connectMongo();
  const n = await Organization.countDocuments({}).limit(1);
  return n > 0;
});

/**
 * Every ACTIVE organization, ordered stably. Used only where membership is
 * not the question — the single-organization compatibility path and the
 * non-request fallback.
 */
const listActiveOrganizations = cache(
  async (): Promise<OrganizationSummary[]> => {
    await connectMongo();
    const rows = await Organization.find({ status: RecordState.ACTIVE })
      .sort({ isDefault: -1, createdAt: 1 })
      .select(SUMMARY_FIELDS)
      .lean<OrganizationSummarySource[]>();
    return rows.map(toSummary);
  },
);

/**
 * Organizations the signed-in user may act in.
 *
 * THE ONE FUNNEL. `getSelectedOrganization` re-checks the cookie against it,
 * `assertOrganizationAccess` validates client-supplied ids against it, and
 * `getRequestOrganizationScope` derives the Mongo scope clause from that
 * result — so a client cannot opt out of it anywhere.
 *
 * Empty when unauthenticated, when the user has no ACTIVE memberships, or
 * when the deployment pin excludes every organization they belong to.
 */
export const listMemberOrganizations = cache(
  async (): Promise<OrganizationSummary[]> => {
    const user = await getCurrentUser().catch(() => null);
    if (!user) return [];

    await connectMongo();

    const memberships = await OrganizationMember.find({
      userId: new Types.ObjectId(user.id),
      // ACTIVE only — this is what makes revocation immediate. Removing
      // someone sets the membership DISABLED rather than deleting it, and
      // the very next request stops resolving that organization.
      status: RecordState.ACTIVE,
    })
      .select("organizationId")
      .lean<{ organizationId: Types.ObjectId }[]>();

    if (memberships.length === 0) return [];

    const filter: Record<string, unknown> = {
      _id: { $in: memberships.map((m) => m.organizationId) },
      status: RecordState.ACTIVE,
    };
    const pin = deploymentPin();
    if (pin) filter.slug = pin;

    const orgs = await Organization.find(filter)
      .sort({ isDefault: -1, name: 1 })
      .select(SUMMARY_FIELDS)
      .lean<OrganizationSummarySource[]>();

    return orgs.map(toSummary);
  },
);

/**
 * The organization this request is acting in, or null.
 *
 * Resolution order:
 *   1. the selected-org cookie, if it names one of the user's memberships
 *   2. the user's only membership, when they have exactly one
 *
 * Rule 2 is what keeps a single-brand deployment cookie-free: the Himanshu
 * console never sets a selection today and must not start requiring one.
 */
export const getSelectedOrganization = cache(
  async (): Promise<OrganizationSummary | null> => {
    const allowed = await listMemberOrganizations();
    if (allowed.length === 0) return null;

    const selectedId = await readSelectedOrgCookie();
    if (selectedId && Types.ObjectId.isValid(selectedId)) {
      const match = allowed.find((o) => o.id === selectedId);
      if (match) return match;
      // A cookie naming an organization they may not use is discarded
      // rather than honoured. Fall through to the single-membership rule.
    }

    return allowed.length === 1 ? allowed[0]! : null;
  },
);

/** The organization, or a refusal. For server code that must not proceed
 *  without an explicit, authorized selection. */
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
 * This is what API routes call when an organization id arrives from a
 * client. It NEVER trusts the supplied id: it is accepted only if it matches
 * one of the caller's own ACTIVE memberships.
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
 *  global `User.role`. Null when they are not an ACTIVE member. */
export async function getOrganizationRole(
  organizationId: string,
): Promise<UserRole | null> {
  const user = await getCurrentUser().catch(() => null);
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

/* ─────────────────── the resolved organization ─────────────────── */

/**
 * The organization for the current context, falling back through the
 * compatibility rules. Throws only when the deployment has no organization
 * at all, which is a misconfiguration rather than a state to serve blankly.
 *
 * Prefer `getSelectedOrganization()` in request paths that can render a
 * chooser. This exists for the many callers that simply need "the tenant".
 */
export async function getOrganization(): Promise<OrganizationSummary> {
  const pinned = pinnedOrganization.getStore();
  if (pinned?.organizationId) {
    const org = (await listActiveOrganizations()).find(
      (o) => o.id === pinned.organizationId,
    );
    if (org) return org;
  }

  const selected = await getSelectedOrganization();
  if (selected) return selected;

  // No selection. On a single-organization deployment that IS the answer;
  // this is the path the Himanshu console takes on every request today.
  const active = await listActiveOrganizations();
  const pin = deploymentPin();
  const candidates = pin ? active.filter((o) => o.slug === pin) : active;

  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length === 0) {
    throw new Error(
      pin
        ? `No ACTIVE organization matches PAYOPS_ORG_SLUG="${pin}". Check the deployment configuration.`
        : "No organization is seeded. Run `npm run seed:orgs` before starting the application.",
    );
  }

  // Several organizations and nothing selected. Returning one of them would
  // be picking a tenant at random, which is precisely the bug this layer
  // exists to prevent.
  throw new ForbiddenError("Select an organization to continue");
}

/** The organization id, for the many callers that only need to stamp it. */
export async function resolveOrganizationId(): Promise<string> {
  return (await getOrganization()).id;
}

/**
 * What this organization sells.
 *
 * The create-order page renders its tab strip from this, and the create
 * route refuses anything outside it — so a hand-crafted POST cannot write a
 * cruise order for a brand that sells only car rental. Never empty: an
 * unmigrated organization resolves to `[CAR_RENTAL]`.
 */
export async function resolveOrganizationServiceTypes(): Promise<
  ServiceType[]
> {
  return (await getOrganization()).serviceTypes;
}

/* ─────────────────────────── the scope ─────────────────────────── */

/**
 * The tenancy scope for any code path, browser request or not.
 *
 * Order of precedence, and every branch is load-bearing:
 *
 *   1. AN EXPLICIT PIN (`runWithOrganization`) — a webhook or a script that
 *      already knows its tenant. Wins outright.
 *   2. THE SELECTED ORGANIZATION — cookie validated against membership.
 *   3. EXACTLY ONE ACTIVE ORGANIZATION — the single-brand deployment. This
 *      is the Himanshu path and it must keep returning what it returns
 *      today, including for webhook and outbox contexts that have no
 *      session at all.
 *   4. NO ORGANIZATIONS — unscoped, byte-identical to the pre-migration
 *      world.
 *   5. SEVERAL ORGANIZATIONS, NOTHING SELECTED — `denyAll`. The caller has
 *      not proved which tenant they are, so they see nothing rather than
 *      everything. This is the branch that stops a direct API call carrying
 *      only a session cookie from reading both brands.
 *
 * `isDefault` comes from the organization document. Only the default
 * organization matches unattributed rows, which keeps Himanshu's history
 * visible without ever exposing it to RCR Cruise.
 */
export async function getRequestOrganizationScope(): Promise<OrganizationScopeInput> {
  const pinned = pinnedOrganization.getStore();
  if (pinned) return pinned;

  const selected = await getSelectedOrganization();
  if (selected) {
    return { organizationId: selected.id, isDefault: selected.isDefault };
  }

  const active = await listActiveOrganizations();
  const pin = deploymentPin();
  const candidates = pin ? active.filter((o) => o.slug === pin) : active;

  if (candidates.length === 0) {
    // Either an unmigrated deployment (no scoping applies) or a pin that
    // matches nothing. The latter is a misconfiguration, but returning
    // "unscoped" there would silently widen every query — deny instead.
    return pin
      ? { organizationId: null, isDefault: false, denyAll: true }
      : { organizationId: null, isDefault: false };
  }

  if (candidates.length === 1) {
    const only = candidates[0]!;
    return { organizationId: only.id, isDefault: only.isDefault };
  }

  return { organizationId: null, isDefault: false, denyAll: true };
}

/* ─────────────────────────── test seam ─────────────────────────── */

/**
 * Test seam.
 *
 * `cache()` is per-request in production and per-invocation in tests, so
 * there is no module-level memo to clear any more — the previous
 * process-lifetime cache was itself a multi-tenant bug. Kept as a no-op so
 * the existing suite's call sites stay valid.
 */
export function _resetOrganizationCacheForTests(): void {
  /* no persistent cache to reset — see the note above */
}
