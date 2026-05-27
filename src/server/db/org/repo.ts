import "server-only";

import type { Model } from "mongoose";

import { orgIdFilter, requireOrgId } from "./org-context";

// Mongoose's narrow query / update types vary between major versions
// and aren't worth chasing here. The repo's public surface is small
// enough that we can express it with permissive structural types and
// keep the per-call cast localised inside this file.
type AnyFilter = Record<string, unknown>;
type AnyUpdate = Record<string, unknown>;
type AnyOptions = Record<string, unknown>;

/**
 * Reusable org-scoped data-access helpers.
 *
 * Why this exists (read this before you write a raw `Model.find` again):
 *
 *   Every multi-tenant production incident eventually traces back to one
 *   forgotten `orgId` clause. We do NOT trust ourselves to remember it on
 *   every query — we channel reads/writes through these helpers and
 *   require `orgId` at the type level.
 *
 * Phase 0 ships the pattern + the helpers. Phase 0 does NOT rewrite every
 * existing call site (that would balloon the blast radius). New code,
 * and refactors that already touch a query, MUST use these helpers.
 *
 * Eventual goal: an ESLint rule that bans `Model.find` / `findOne` /
 * `findById` outside `src/server/db/**`. That rule lands once every
 * service has been migrated through.
 *
 * SCOPE_OK escape hatch:
 *   - Read helpers below auto-inject the `orgId` clause.
 *   - For genuinely cross-tenant reads (platform-admin analytics, system
 *     jobs), call the model directly AND add a `// SCOPE_OK: <reason>`
 *     comment above the line so reviewers see the intent.
 */

interface OrgScopedDoc {
  /** Mongoose model docs the helpers operate on must declare orgId. */
  orgId?: unknown;
}

export class OrgScopedRepo<TDoc extends OrgScopedDoc> {
  constructor(private readonly model: Model<TDoc>) {}

  /** Compose a filter with the orgId clause pinned. */
  private scopedFilter(orgId: string, extra: AnyFilter = {}): AnyFilter {
    return { ...extra, orgId: orgIdFilter(orgId) };
  }

  async findOne(
    orgId: string,
    filter: AnyFilter = {},
    options: AnyOptions = {},
  ): Promise<TDoc | null> {
    requireOrgId(orgId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = this.model as any;
    return m.findOne(this.scopedFilter(orgId, filter), null, options).lean();
  }

  async find(
    orgId: string,
    filter: AnyFilter = {},
    options: AnyOptions = {},
  ): Promise<TDoc[]> {
    requireOrgId(orgId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = this.model as any;
    return m.find(this.scopedFilter(orgId, filter), null, options).lean();
  }

  async countDocuments(orgId: string, filter: AnyFilter = {}): Promise<number> {
    requireOrgId(orgId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = this.model as any;
    return m.countDocuments(this.scopedFilter(orgId, filter));
  }

  async findOneAndUpdate(
    orgId: string,
    filter: AnyFilter,
    update: AnyUpdate,
    options: AnyOptions = {},
  ): Promise<TDoc | null> {
    requireOrgId(orgId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = this.model as any;
    return m
      .findOneAndUpdate(this.scopedFilter(orgId, filter), update, options)
      .lean();
  }

  async updateMany(
    orgId: string,
    filter: AnyFilter,
    update: AnyUpdate,
    options: AnyOptions = {},
  ): Promise<{ matchedCount: number; modifiedCount: number }> {
    requireOrgId(orgId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = this.model as any;
    const res = await m.updateMany(
      this.scopedFilter(orgId, filter),
      update,
      options,
    );
    return {
      matchedCount: res.matchedCount ?? 0,
      modifiedCount: res.modifiedCount ?? 0,
    };
  }

  async deleteOne(
    orgId: string,
    filter: AnyFilter,
  ): Promise<{ deletedCount: number }> {
    requireOrgId(orgId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = this.model as any;
    const res = await m.deleteOne(this.scopedFilter(orgId, filter));
    return { deletedCount: res.deletedCount ?? 0 };
  }
}

/**
 * Factory for the small set of repos we ship in Phase 1. New repos get
 * added here so the rest of the codebase has one place to import from.
 *
 * NB: the legacy services (`order.service.ts`, `branding.service.ts`,
 * etc.) keep their direct `Model.find` calls during this phase. They get
 * migrated in a follow-up pass once we've validated the pattern in green
 * code paths.
 */
export function createOrgScopedRepo<TDoc extends OrgScopedDoc>(
  model: Model<TDoc>,
): OrgScopedRepo<TDoc> {
  return new OrgScopedRepo<TDoc>(model);
}
