import "server-only";

import { Types } from "mongoose";

/**
 * Turning "the caller is acting in organization X" into a Mongo filter.
 *
 * Two rules, and the first one is the whole compatibility story:
 *
 *   DEFAULT ORGANIZATION — sees its own rows AND every row that has no
 *   organization at all. Records written before the migration have a null
 *   `organizationId`, and the default organization is who they belonged to.
 *   Without this, the instant the column shipped every historical order,
 *   audit row and dispute would vanish from the UI. It also means the
 *   backfill can be interrupted, re-run, or never run at all and nothing
 *   becomes unreachable.
 *
 *   EVERY OTHER ORGANIZATION — sees only rows explicitly stamped with its
 *   id. Unattributed rows are NOT theirs. A new tenant must never inherit
 *   another brand's history by default; that is the leak this whole layer
 *   exists to prevent.
 *
 * And a third case that keeps this safe to deploy: on a deployment with no
 * organizations at all the scope is empty, so queries are byte-identical to
 * what they were before any of this existed.
 *
 * COMPOSITION. The clause is returned for `$and`, never merged into the
 * caller's filter object. That is deliberate: `listOrders` already sets a
 * top-level `$or` for its search box, and assigning a second `$or` would
 * silently overwrite it — the search would quietly stop filtering, or the
 * scope would, depending on key order. Nesting under `$and` composes with
 * anything.
 */

export interface OrganizationScopeInput {
  /** Selected organization id, or null on an unmigrated deployment. */
  organizationId: string | null;
  /** Whether that organization is the compatibility anchor. */
  isDefault: boolean;
}

/** A Mongo clause safe to push onto `$and`. */
export type ScopeClause = Record<string, unknown>;

/**
 * The clause restricting a query to one organization, or `null` when no
 * scoping applies (unmigrated deployment).
 */
export function organizationScopeClause(
  scope: OrganizationScopeInput,
): ScopeClause | null {
  if (!scope.organizationId) return null;
  if (!Types.ObjectId.isValid(scope.organizationId)) {
    // A malformed id must never widen the query. Match nothing rather than
    // fall through to "no scope".
    return { _id: { $in: [] } };
  }
  const id = new Types.ObjectId(scope.organizationId);

  if (!scope.isDefault) {
    return { organizationId: id };
  }

  return {
    $or: [
      { organizationId: id },
      { organizationId: null },
      { organizationId: { $exists: false } },
    ],
  };
}

/**
 * Compose a scope clause into an existing filter without disturbing it.
 *
 * Returns a NEW object; the caller's filter is not mutated. Existing
 * top-level `$or` / `$and` keys survive intact.
 */
export function withOrganizationScope<T extends Record<string, unknown>>(
  filter: T,
  scope: OrganizationScopeInput,
): T & { $and?: ScopeClause[] } {
  const clause = organizationScopeClause(scope);
  if (!clause) return { ...filter };

  const existingAnd = Array.isArray(filter.$and)
    ? (filter.$and as ScopeClause[])
    : [];
  return { ...filter, $and: [...existingAnd, clause] };
}

/**
 * The `organizationId` to stamp on a newly created record.
 *
 * Null on an unmigrated deployment, which is exactly what pre-migration
 * rows carry — so writes stay consistent with reads in both worlds.
 */
export function organizationStamp(
  scope: OrganizationScopeInput,
): Types.ObjectId | null {
  if (!scope.organizationId || !Types.ObjectId.isValid(scope.organizationId)) {
    return null;
  }
  return new Types.ObjectId(scope.organizationId);
}

/**
 * Whether a document the caller already holds belongs to their scope.
 *
 * Used on the fetch-by-id paths, where the query is `findById` and adding a
 * filter would turn "someone else's order" into a confusing 404 chain. The
 * caller checks this and raises NotFound so the response is identical to a
 * genuinely missing record — a different status would let a caller probe
 * which ids exist in other organizations.
 */
export function belongsToScope(
  documentOrganizationId: Types.ObjectId | null | undefined,
  scope: OrganizationScopeInput,
): boolean {
  if (!scope.organizationId) return true; // unmigrated: no scoping
  const docId = documentOrganizationId ? String(documentOrganizationId) : null;
  if (docId === scope.organizationId) return true;
  // Unattributed history belongs to the default organization only.
  return docId === null && scope.isDefault;
}
