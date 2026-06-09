import "server-only";

import { Types, type Model } from "mongoose";

import { orgIdFilter } from "./org-context";

/**
 * Per-org "singleton" reader with lazy provisioning.
 *
 * Settings/Branding (and a few others) used to be a single row keyed by
 * `{ key: "default" }`. Multi-tenant requires one row per organization.
 * To keep the migration safe, this helper implements:
 *
 *   1. If `orgId` provided AND a per-org row exists → return it.
 *   2. If `orgId` provided AND no per-org row exists → call `seedFor`
 *      to build the seed values (typically by cloning the legacy
 *      `{ key: "default" }` row), insert with `orgId` set + `key`
 *      omitted, and return the inserted doc.
 *   3. If `orgId` NOT provided → return the legacy singleton row
 *      (back-compat for callers that haven't been org-aware-ified yet).
 *
 * Concurrency: step 2 races on the partial-unique index on `orgId`.
 * The loser catches the duplicate-key error and re-reads, so two
 * concurrent first-access calls don't produce duplicate rows.
 *
 * Why this lives in `/db/org/` and not in the service layer: the same
 * pattern applies to Setting, Branding, and (eventually) any other
 * per-org singleton. Centralising the lazy-clone primitive means no
 * service has to re-derive the concurrency guard.
 */

interface ReadOptions<TDoc> {
  /** Active organization id (hex string). When null/undefined, the
   *  helper falls back to the legacy singleton row keyed by
   *  `legacyKey`. */
  orgId: string | null | undefined;
  /** Field name on the document that holds the legacy singleton key.
   *  For Setting + Branding this is `"key"`. */
  legacyKeyField: string;
  /** Legacy singleton key value. Typically `"default"`. */
  legacyKeyValue: string;
  /** Build the seed payload for a new per-org row. Called with the
   *  legacy row (if any) so the caller can clone its fields onto the
   *  new row. MUST NOT include `key`, the partial-unique on `key`
   *  reserves that field for the legacy singleton. */
  seedFor: (legacy: TDoc | null, orgId: string) => Record<string, unknown>;
}

export async function loadScopedSingleton<TDoc extends { orgId?: unknown }>(
  model: Model<TDoc>,
  opts: ReadOptions<TDoc>,
): Promise<TDoc | null> {
  // Legacy-fallback path: no orgId in context → behave exactly like the
  // pre-multi-tenant code did. Tenant #1 stays on this path until every
  // caller has been migrated.
  if (!opts.orgId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = model as any;
    return (await m
      .findOne({ [opts.legacyKeyField]: opts.legacyKeyValue })
      .lean()) as TDoc | null;
  }

  if (!Types.ObjectId.isValid(opts.orgId)) {
    throw new Error(`Invalid orgId passed to loadScopedSingleton: ${opts.orgId}`);
  }
  const orgFilter = orgIdFilter(opts.orgId);

  // Fast path: per-org row already exists.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = model as any;
  const existing = (await m.findOne({ orgId: orgFilter }).lean()) as
    | TDoc
    | null;
  if (existing) return existing;

  // Slow path: lazy-provision from the legacy seed.
  const legacy = (await m
    .findOne({ [opts.legacyKeyField]: opts.legacyKeyValue })
    .lean()) as TDoc | null;
  const seed = opts.seedFor(legacy, opts.orgId);
  // Defensive: never let a caller smuggle `key` into a per-org row -
  // doing so would re-engage the legacy unique constraint and prevent
  // future seeds for other orgs.
  if ("key" in seed) {
    delete (seed as Record<string, unknown>).key;
  }
  try {
    const created = await model.create({
      ...seed,
      orgId: orgFilter,
    } as never);
    return (created.toObject() as TDoc) ?? null;
  } catch (err) {
    // Duplicate-key (E11000) on `orgId` means a concurrent first-access
    // call beat us to it. Re-read and return.
    if (isDuplicateKey(err)) {
      const raced = (await m.findOne({ orgId: orgFilter }).lean()) as
        | TDoc
        | null;
      if (raced) return raced;
    }
    throw err;
  }
}

function isDuplicateKey(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  return (err as { code?: number }).code === 11000;
}
