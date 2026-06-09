
/**
 * Backfill `trialStartsAt = now` on every Organization that doesn't
 * yet have a value.
 *
 * Why: the 15-day evaluation trial gate (commit landing alongside
 * this script) reads from `Organization.trialStartsAt`, falling back
 * to `createdAt` when the field is null. A dev workspace older than
 * 15 days would immediately expire on first request the moment the
 * gate ships, the wrong default for a feature that's just landing.
 *
 * This script gives every existing tenant (including your own dev
 * workspace) a fresh 15-day window starting from the moment it runs.
 * New signups stamp the field directly in signup.service.
 *
 * Idempotent: rows that already carry a trialStartsAt are left alone.
 * Re-running is a no-op.
 *
 * Run:
 *   npx tsx --require ./scripts/shim-server-only.cjs \
 *     scripts/backfill-trial-start.ts            # dry run
 *   npx tsx --require ./scripts/shim-server-only.cjs \
 *     scripts/backfill-trial-start.ts --apply    # write
 */

import mongoose from "mongoose";

import { Organization } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  await connectMongo();

  const candidates = await Organization.find({
    $or: [{ trialStartsAt: null }, { trialStartsAt: { $exists: false } }],
  })
    .select({ _id: 1, slug: 1, name: 1, createdAt: 1 })
    .lean<
      { _id: unknown; slug: string; name: string; createdAt: Date }[]
    >();

  console.log(
    `Found ${candidates.length} org row(s) without trialStartsAt ${apply ? "(APPLY MODE)" : "(dry run, use --apply to write)"}`,
  );

  if (!apply) {
    for (const row of candidates.slice(0, 20)) {
      console.log(
        `  would set trialStartsAt=now for org=${row.slug} (${row.name}, created ${row.createdAt.toISOString()})`,
      );
    }
    if (candidates.length > 20) {
      console.log(`  ... and ${candidates.length - 20} more`);
    }
  } else {
    const now = new Date();
    const res = await Organization.updateMany(
      {
        $or: [{ trialStartsAt: null }, { trialStartsAt: { $exists: false } }],
      },
      { $set: { trialStartsAt: now } },
    );
    console.log(
      `Updated ${res.modifiedCount} org row(s); each now has trialStartsAt=${now.toISOString()}`,
    );
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
