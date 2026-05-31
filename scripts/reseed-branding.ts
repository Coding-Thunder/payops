 
/**
 * Reseed a tenant's Branding row from their Organization + founder data.
 *
 * Why this exists: the multi-tenant branding fix landed AFTER some
 * tenants' Branding rows were already created with the old env default
 * ("Rental Confirmation"). Those stale rows now leak the platform's
 * legacy brand into the tenant's customer emails. Re-seeding picks up
 * the tenant's actual Org name and founder email.
 *
 * Two modes:
 *
 *   1. Single org by id (precise, manual):
 *        npx tsx --require ./scripts/shim-server-only.cjs \
 *          scripts/reseed-branding.ts <orgId>
 *
 *   2. Bulk repair of stale-default rows (safe, idempotent):
 *        npx tsx --require ./scripts/shim-server-only.cjs \
 *          scripts/reseed-branding.ts --repair-stale
 *
 *      Overwrites brandName / supportEmail ONLY when the existing
 *      values match the known stale defaults:
 *        brandName === "Rental Confirmation"
 *        supportEmail === "support@rentalconfirmation.com"
 *      Tenants who already customized their brand are untouched.
 */

import mongoose, { Types } from "mongoose";

import { Branding, Organization, User } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";

const STALE_BRAND_NAME = "Rental Confirmation";
const STALE_SUPPORT_EMAIL = "support@rentalconfirmation.com";

interface SeedSource {
  orgName: string;
  founderEmail: string;
}

async function readSeedSource(orgId: string): Promise<SeedSource | null> {
  const org = await Organization.findById(orgId)
    .select({ name: 1, ownerUserId: 1 })
    .lean<{ name: string; ownerUserId: unknown }>();
  if (!org) {
    console.error(`Org ${orgId} not found`);
    return null;
  }
  const owner = await User.findById(org.ownerUserId)
    .select({ email: 1 })
    .lean<{ email: string }>();
  if (!owner) {
    console.error(`Founder for org ${orgId} not found`);
    return null;
  }
  return { orgName: org.name, founderEmail: owner.email };
}

async function reseedOne(orgId: string): Promise<void> {
  const seed = await readSeedSource(orgId);
  if (!seed) return;
  const oid = new Types.ObjectId(orgId);
  const result = await Branding.findOneAndUpdate(
    { orgId: oid },
    {
      $set: {
        brandName: seed.orgName,
        supportEmail: seed.founderEmail.toLowerCase(),
      },
    },
    { new: true },
  ).lean<{ brandName: string; supportEmail: string } | null>();
  if (!result) {
    console.log(`No Branding row for org ${orgId} (lazy-seed will create on next access)`);
    return;
  }
  console.log(
    `org=${orgId} → brandName="${result.brandName}", supportEmail="${result.supportEmail}"`,
  );
}

async function repairStale(): Promise<void> {
  // Only touch rows whose values match the known stale defaults. A
  // tenant who legitimately named their workspace "Rental Confirmation"
  // would get overwritten too — acceptable risk on a fresh platform
  // (no real tenants are named that today).
  const candidates = await Branding.find({
    $or: [
      { brandName: STALE_BRAND_NAME },
      { supportEmail: STALE_SUPPORT_EMAIL },
    ],
    orgId: { $type: "objectId" },
  })
    .select({ _id: 1, orgId: 1, brandName: 1, supportEmail: 1 })
    .lean<{ _id: unknown; orgId: unknown; brandName: string; supportEmail: string }[]>();

  console.log(`Found ${candidates.length} stale Branding row(s)`);
  for (const row of candidates) {
    const orgId = String(row.orgId);
    const seed = await readSeedSource(orgId);
    if (!seed) {
      console.log(`  skip ${row._id}: org missing or owner missing`);
      continue;
    }
    const update: Record<string, string> = {};
    if (row.brandName === STALE_BRAND_NAME) update.brandName = seed.orgName;
    if (row.supportEmail === STALE_SUPPORT_EMAIL)
      update.supportEmail = seed.founderEmail.toLowerCase();
    if (Object.keys(update).length === 0) continue;
    await Branding.updateOne({ _id: row._id }, { $set: update });
    console.log(`  repaired org=${orgId} → ${JSON.stringify(update)}`);
  }
}

async function main(): Promise<void> {
  await connectMongo();
  const arg = process.argv[2];
  if (!arg) {
    console.error(
      "usage:\n  scripts/reseed-branding.ts <orgId>\n  scripts/reseed-branding.ts --repair-stale",
    );
    process.exit(2);
  }
  if (arg === "--repair-stale") {
    await repairStale();
  } else {
    await reseedOne(arg);
  }
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
