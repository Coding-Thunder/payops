/* eslint-disable no-console */
/**
 * Phase 0 + Phase 1 migration: introduce the tenant spine.
 *
 * Idempotent. Safe to re-run. Reads `MONGODB_URI` from the same env
 * surface every other script uses.
 *
 * What it does:
 *   1. Connects + ensures every model's indexes are in sync.
 *   2. Creates (or finds) the legacy `Organization` keyed by slug
 *      `legacy`. Owner = first SUPER_ADMIN.
 *   3. Creates one `OrgMember` row per existing user (role mirrored
 *      from `User.role`).
 *   4. Sets `User.primaryOrgId = <legacy org>` for users whose pointer
 *      is null.
 *   5. Backfills `orgId = <legacy org>` on every existing row of
 *      Order, Setting, Branding, Provider, EmailTemplate, AuditLog.
 *
 * What it does NOT do:
 *   - Add orgId to CarLink / Quotation / PaymentConsent / Dispute /
 *     OrderEvidence / OrderDraft / Outbox. Those land in a follow-up
 *     pass once Phase 1 is verified in production.
 *   - Make `orgId` required on any model. That comes once the
 *     application has been running on this schema for a few weeks and
 *     a sentinel query proves zero null-orgId rows survive.
 *   - Drop the legacy `key` unique indexes on Setting/Branding.
 *
 * Usage:
 *   npm run migrate:tenant-spine
 *
 * Rollback:
 *   See PHASE-0-1-NOTES.md (also added in this pass) — TL;DR the
 *   migration only writes; rollback drops the two new collections and
 *   `$unset`s the orgId fields. Old code paths remain functional
 *   throughout because the application keeps reading via legacy
 *   singleton keys.
 */

import { connectMongo, disconnectMongo } from "../src/server/db/mongoose";
import {
  AuditLog,
  Branding,
  EmailTemplate,
  Order,
  Organization,
  OrgMember,
  OrgStatus,
  Setting,
  User,
} from "../src/server/db/models";
import { LEGACY_ORG_SLUG } from "../src/server/db/org/legacy";
import { RecordState, UserRole } from "../src/lib/constants/enums";
import { env } from "../src/lib/env";

interface MigrationSummary {
  orgCreated: boolean;
  orgId: string;
  ownerUserId: string;
  membersUpserted: number;
  usersPrimaryOrgUpdated: number;
  orders: { matched: number; modified: number };
  settings: { matched: number; modified: number };
  branding: { matched: number; modified: number };
  emailTemplates: { matched: number; modified: number };
  auditLogs: { matched: number; modified: number };
}

async function ensureIndexes(): Promise<void> {
  console.log("→ Syncing indexes (this may take a few seconds)…");
  await Promise.all([
    Organization.syncIndexes(),
    OrgMember.syncIndexes(),
    User.syncIndexes(),
    Order.syncIndexes(),
    Setting.syncIndexes(),
    Branding.syncIndexes(),
    EmailTemplate.syncIndexes(),
    AuditLog.syncIndexes(),
  ]);
  console.log("  ✓ Indexes synced");
}

async function findOrCreateLegacyOrg(): Promise<{
  orgId: string;
  ownerUserId: string;
  created: boolean;
}> {
  const existing = (await Organization.findOne({ slug: LEGACY_ORG_SLUG }).lean()) as
    | { _id: unknown; ownerUserId: unknown }
    | null;
  if (existing) {
    return {
      orgId: String(existing._id),
      ownerUserId: String(existing.ownerUserId),
      created: false,
    };
  }

  // First SUPER_ADMIN becomes the org owner. Fall back to the
  // earliest-created ACTIVE user if none exists (a brand-new install
  // with only ADMINs is unlikely but worth handling gracefully).
  const owner = (await User.findOne({
    role: UserRole.SUPER_ADMIN,
    status: RecordState.ACTIVE,
  })
    .sort({ createdAt: 1 })
    .select({ _id: 1 })
    .lean()) as { _id: unknown } | null;
  const fallbackOwner =
    owner ??
    ((await User.findOne({ status: RecordState.ACTIVE })
      .sort({ createdAt: 1 })
      .select({ _id: 1 })
      .lean()) as { _id: unknown } | null);
  if (!fallbackOwner) {
    throw new Error(
      "No users found — run `npm run seed` first to create at least one SUPER_ADMIN.",
    );
  }

  // `Organization.create` expects a proper Mongoose model input; we
  // cast the dynamic shape since the script bypasses our usual zod
  // boundary.
  const created = await Organization.create({
    slug: LEGACY_ORG_SLUG,
    name: env.server.CUSTOMER_BRAND_NAME || "Legacy Tenant",
    ownerUserId: fallbackOwner._id as never,
    status: OrgStatus.ACTIVE,
    verifiedAt: new Date(),
  });
  return {
    orgId: String(created._id),
    ownerUserId: String(fallbackOwner._id),
    created: true,
  };
}

async function attachAllUsersToOrg(orgId: string): Promise<number> {
  const users = (await User.find({})
    .select({ _id: 1, role: 1, status: 1 })
    .lean()) as Array<{ _id: unknown; role: UserRole; status: RecordState }>;
  let upserted = 0;
  for (const u of users) {
    const res = await OrgMember.updateOne(
      { orgId, userId: u._id as never },
      {
        $setOnInsert: {
          orgId,
          userId: u._id,
          role: u.role,
          status: u.status,
          joinedAt: new Date(),
        },
      },
      { upsert: true },
    );
    // upsertedCount is 1 when we inserted a fresh row; modifiedCount > 0
    // would mean we found an existing one (we never $set on conflict).
    if (res.upsertedCount && res.upsertedCount > 0) upserted += 1;
  }
  return upserted;
}

async function setPrimaryOrgForUsers(orgId: string): Promise<number> {
  // Only update users that don't already have a primaryOrgId set.
  // Idempotent — re-running is a no-op.
  const res = await User.updateMany(
    { $or: [{ primaryOrgId: { $exists: false } }, { primaryOrgId: null }] },
    { $set: { primaryOrgId: orgId } },
  );
  return res.modifiedCount ?? 0;
}

async function backfillOrgId<T extends { matchedCount?: number; modifiedCount?: number }>(
  label: string,
  fn: () => Promise<T>,
): Promise<{ matched: number; modified: number }> {
  console.log(`→ Backfilling ${label}…`);
  const res = await fn();
  const matched = res.matchedCount ?? 0;
  const modified = res.modifiedCount ?? 0;
  console.log(`  ✓ ${label}: matched=${matched} modified=${modified}`);
  return { matched, modified };
}

async function main(): Promise<void> {
  await connectMongo();
  await ensureIndexes();

  const { orgId, ownerUserId, created } = await findOrCreateLegacyOrg();
  console.log(
    `→ Legacy organization: ${created ? "created" : "found"} (id=${orgId}, owner=${ownerUserId})`,
  );

  const membersUpserted = await attachAllUsersToOrg(orgId);
  console.log(`  ✓ OrgMember rows upserted: ${membersUpserted}`);

  const usersPrimaryOrgUpdated = await setPrimaryOrgForUsers(orgId);
  console.log(`  ✓ User.primaryOrgId backfilled: ${usersPrimaryOrgUpdated}`);

  const orders = await backfillOrgId("orders", () =>
    Order.updateMany({ orgId: { $exists: false } }, { $set: { orgId } }),
  );
  const settings = await backfillOrgId("settings", () =>
    Setting.updateMany({ orgId: { $exists: false } }, { $set: { orgId } }),
  );
  const branding = await backfillOrgId("branding", () =>
    Branding.updateMany({ orgId: { $exists: false } }, { $set: { orgId } }),
  );
  const emailTemplates = await backfillOrgId("email_templates", () =>
    EmailTemplate.updateMany(
      { orgId: { $exists: false } },
      { $set: { orgId } },
    ),
  );
  const auditLogs = await backfillOrgId("audit_logs", () =>
    AuditLog.updateMany({ orgId: { $exists: false } }, { $set: { orgId } }),
  );

  const summary: MigrationSummary = {
    orgCreated: created,
    orgId,
    ownerUserId,
    membersUpserted,
    usersPrimaryOrgUpdated,
    orders,
    settings,
    branding,
    emailTemplates,
    auditLogs,
  };
  console.log("\n=== Migration summary ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log(
    "\nDone. Next steps:\n" +
      "  1. Smoke the app — every page should render and reads should\n" +
      "     resolve via the legacy {key:\"default\"} path.\n" +
      "  2. Sign out + sign back in: the new JWT will carry orgId.\n" +
      "  3. Verify there are no rows left without orgId:\n" +
      "       db.orders.countDocuments({orgId: {$exists: false}})\n" +
      "       (same for settings/branding/email_templates/audit_logs)\n" +
      "  4. Run the unit test suite: npm run test:unit\n",
  );
}

main()
  .then(() => disconnectMongo())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Migration failed:", err);
    disconnectMongo().finally(() => process.exit(1));
  });
