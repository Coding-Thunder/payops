
/**
 * Reset a tenant's 15-day evaluation trial by pushing `trialStartsAt`
 * forward.
 *
 * Use case: a customer emails sales@ asking for more time before
 * Stripe Billing is wired up. Run this with their org slug or
 * Mongo _id; they get another fresh 15-day window starting from
 * the moment the script writes.
 *
 * Run:
 *   npx tsx --require ./scripts/shim-server-only.cjs \
 *     scripts/extend-trial.ts <slug-or-id>            # dry run
 *   npx tsx --require ./scripts/shim-server-only.cjs \
 *     scripts/extend-trial.ts <slug-or-id> --apply    # write
 *
 * Examples:
 *   scripts/extend-trial.ts vinay-maheshwari-s-workspace --apply
 *   scripts/extend-trial.ts 6731e0a3...                --apply
 */

import mongoose, { Types } from "mongoose";

import { Organization } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";

async function findOrg(identifier: string): Promise<{
  _id: unknown;
  slug: string;
  name: string;
  trialStartsAt?: Date | null;
  createdAt: Date;
} | null> {
  const isObjectId = Types.ObjectId.isValid(identifier);
  const filter = isObjectId
    ? { _id: new Types.ObjectId(identifier) }
    : { slug: identifier.toLowerCase().trim() };
  return Organization.findOne(filter)
    .select({ _id: 1, slug: 1, name: 1, trialStartsAt: 1, createdAt: 1 })
    .lean<{
      _id: unknown;
      slug: string;
      name: string;
      trialStartsAt?: Date | null;
      createdAt: Date;
    }>();
}

async function main(): Promise<void> {
  const identifier = process.argv[2];
  const apply = process.argv.includes("--apply");
  if (!identifier) {
    console.error(
      "usage: scripts/extend-trial.ts <slug-or-id> [--apply]",
    );
    process.exit(2);
  }

  await connectMongo();
  const org = await findOrg(identifier);
  if (!org) {
    console.error(`No org found for "${identifier}"`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const previous = org.trialStartsAt ?? org.createdAt;
  const next = new Date();
  console.log(`Org: ${org.slug} (${org.name})`);
  console.log(`  previous trialStartsAt: ${previous.toISOString()}`);
  console.log(`  next     trialStartsAt: ${next.toISOString()}`);

  if (!apply) {
    console.log("");
    console.log("Dry run, use --apply to write.");
    await mongoose.disconnect();
    return;
  }

  await Organization.updateOne(
    { _id: org._id },
    { $set: { trialStartsAt: next } },
  );
  console.log(`Updated. Trial now expires on ${new Date(next.getTime() + 15 * 24 * 60 * 60 * 1000).toISOString()}.`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
