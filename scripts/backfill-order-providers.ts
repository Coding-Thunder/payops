/* eslint-disable no-console */
/**
 * Backfill the `provider` snapshot on legacy orders that pre-date the
 * provider/brand system.
 *
 * Run:
 *   tsx --env-file=.env.local scripts/backfill-order-providers.ts
 *
 * Knobs (env vars):
 *   BACKFILL_PROVIDER_KEY   default provider key for missing rows. Defaults
 *                           to "BUDGET". Must exist in PROVIDER_SEED or in
 *                           the Provider catalog.
 *   BACKFILL_DRY_RUN        "true" to log what would change without
 *                           writing.
 *
 * Idempotent — safe to re-run. Only touches orders where `provider` is
 * absent or `provider.id` is missing/UNKNOWN. Active provider snapshots
 * are never overwritten.
 */

import { connectMongo, disconnectMongo } from "../src/server/db/mongoose";
import { Order, Provider } from "../src/server/db/models";
import {
  PROVIDER_SEED,
  UNKNOWN_PROVIDER,
  buildProviderSnapshot,
  type ProviderSnapshot,
} from "../src/lib/constants/providers";

const DEFAULT_KEY = (process.env.BACKFILL_PROVIDER_KEY ?? "BUDGET")
  .trim()
  .toUpperCase();
const DRY_RUN = process.env.BACKFILL_DRY_RUN === "true";

async function resolveSnapshot(): Promise<ProviderSnapshot> {
  // Prefer the live catalog entry (so colours match what admins last set).
  const catalogRow = await Provider.findOne({ key: DEFAULT_KEY }).lean<{
    key: string;
    name: string;
    logo: string;
    primaryColor: string;
    onPrimaryColor: string;
  } | null>();
  if (catalogRow) {
    return {
      id: catalogRow.key,
      name: catalogRow.name,
      logo: catalogRow.logo,
      primaryColor: catalogRow.primaryColor,
      onPrimaryColor: catalogRow.onPrimaryColor,
    };
  }
  // Catalog miss — fall back to the static seed.
  const seed = (PROVIDER_SEED as Record<string, (typeof PROVIDER_SEED)["BUDGET"]>)[
    DEFAULT_KEY
  ];
  if (!seed) {
    throw new Error(
      `BACKFILL_PROVIDER_KEY "${DEFAULT_KEY}" is not in the catalog or seed set`,
    );
  }
  return buildProviderSnapshot(seed.id);
}

async function main() {
  console.log(
    `→ Backfilling missing order.provider snapshots with key=${DEFAULT_KEY}${
      DRY_RUN ? " (dry-run)" : ""
    }`,
  );

  await connectMongo();

  const snapshot = await resolveSnapshot();
  const filter = {
    $or: [
      { provider: { $exists: false } },
      { "provider.id": { $in: [null, "", UNKNOWN_PROVIDER.id] } },
    ],
  };

  const count = await Order.countDocuments(filter);
  console.log(`  • orders needing backfill: ${count}`);
  if (count === 0) {
    await disconnectMongo();
    return;
  }

  if (DRY_RUN) {
    const sample = await Order.find(filter, { orderNumber: 1, provider: 1 })
      .limit(5)
      .lean<{ orderNumber: string; provider?: unknown }[]>();
    console.log("  • sample orders that would be updated:");
    for (const o of sample) console.log(`    – ${o.orderNumber}`);
    console.log("  • dry-run: no writes made");
    await disconnectMongo();
    return;
  }

  const result = await Order.updateMany(filter, {
    $set: { provider: snapshot },
  });
  console.log(`  ✓ updated ${result.modifiedCount} order(s)`);
  console.log(
    `    snapshot: ${JSON.stringify({ id: snapshot.id, name: snapshot.name })}`,
  );

  await disconnectMongo();
}

main().catch(async (err) => {
  console.error("Backfill failed:", err);
  await disconnectMongo().catch(() => {});
  process.exit(1);
});
