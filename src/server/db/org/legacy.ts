import "server-only";

import { Organization } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";

/**
 * Constants + helpers for the legacy single-tenant organization that
 * owns every pre-migration row. The migration script seeds the row
 * with this slug so application code can resolve it deterministically.
 *
 * Do NOT add other "magic" org keys here. Multi-tenant onboarding
 * mints fresh slugs at signup time; this constant exists ONLY to
 * bridge the single-tenant → multi-tenant migration.
 */
export const LEGACY_ORG_SLUG = "legacy";

/** Process-scoped cache. Survives across requests but resets on every
 *  cold start. Cleared by `_resetLegacyOrgIdForTesting` between tests. */
let cachedLegacyOrgId: string | null | undefined = undefined;

/**
 * Resolve the legacy organization's id. Returns null when no legacy
 * org exists (fresh install that never ran the migration script).
 *
 * Cached per process — the legacy org never changes id at runtime. If
 * you ever need to bust the cache outside tests, restart the worker.
 */
export async function getLegacyOrgId(): Promise<string | null> {
  if (cachedLegacyOrgId !== undefined) return cachedLegacyOrgId;
  await connectMongo();
  const org = await Organization.findOne({ slug: LEGACY_ORG_SLUG })
    .select({ _id: 1 })
    .lean<{ _id: unknown } | null>();
  cachedLegacyOrgId = org ? String(org._id) : null;
  return cachedLegacyOrgId;
}

/**
 * True iff the given orgId IS the legacy org. False for anything
 * else (including null/undefined, malformed ids, and the case where
 * no legacy org exists at all).
 *
 * Used by `gateway-credentials.service` to gate the env-credential
 * fallback: only the legacy org can resolve to env-based Stripe keys.
 * New tenants without their own per-org `GatewayCredential` row
 * fail closed rather than silently routing money to the platform's
 * Stripe account.
 */
export async function isLegacyTenant(
  orgId: string | null | undefined,
): Promise<boolean> {
  if (!orgId) return false;
  const legacyId = await getLegacyOrgId();
  if (!legacyId) return false;
  return orgId === legacyId;
}

/** Test-only — clears the process-scoped cache. */
export function _resetLegacyOrgIdForTesting(): void {
  cachedLegacyOrgId = undefined;
}
