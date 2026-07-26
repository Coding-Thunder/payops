/**
 * Client Profile backfill.
 *
 * Idempotent. Safe to re-run. Two phases:
 *   A. Link every Order that has no `customerId` to a Client Profile,
 *      resolving email → phone → create (per tenant), then stamp the FK.
 *   B. Rebuild each Customer's denormalised counters (ordersCount,
 *      firstOrderAt, lastOrderAt) authoritatively from its linked orders.
 *
 * Also syncs the new indexes up front — production runs with autoIndex off,
 * so the `orders.customerId` and `customers` (phone / lastOrderAt) indexes
 * are NOT auto-built otherwise.
 *
 * Usage:
 *   npm run migrate:client-profiles           (local, .env.local)
 *   npm run migrate:client-profiles:prod       (prod env)
 *
 * Rollback: the migration only sets `orders.customerId` and rewrites
 * customer counters. To undo, `$unset` customerId on orders — the app keeps
 * reading via the email join throughout, so nothing breaks mid-migration.
 */

import { Types } from "mongoose";

import { connectMongo, disconnectMongo } from "../src/server/db/mongoose";
import { Customer, Order } from "../src/server/db/models";
import { RecordState } from "../src/lib/constants/enums";

interface Summary {
  ordersScanned: number;
  ordersLinked: number;
  customersCreated: number;
  customersRecounted: number;
}

function isDuplicateKey(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: number }).code === 11000
  );
}

async function ensureIndexes(): Promise<void> {
  console.log("→ Syncing Customer + Order indexes…");
  await Promise.all([Customer.syncIndexes(), Order.syncIndexes()]);
  console.log("  ✓ Indexes synced");
}

/** Resolve (or create) the Client Profile for one order's customer snapshot,
 *  mirroring the runtime `resolveOrCreateCustomer` precedence. */
async function resolveCustomerId(
  orgId: Types.ObjectId,
  name: string,
  email: string,
  phone: string,
): Promise<{ id: Types.ObjectId; created: boolean } | null> {
  if (email) {
    const byEmail = await Customer.findOne({ orgId, email })
      .select({ _id: 1 })
      .lean<{ _id: Types.ObjectId } | null>();
    if (byEmail) return { id: byEmail._id, created: false };
  }
  if (phone) {
    const byPhone = await Customer.findOne({ orgId, phone })
      .sort({ createdAt: 1 })
      .select({ _id: 1 })
      .lean<{ _id: Types.ObjectId } | null>();
    if (byPhone) return { id: byPhone._id, created: false };
  }
  if (!email && !phone) return null;
  try {
    const created = await Customer.create({
      orgId,
      name,
      email,
      phone,
      tags: [],
    });
    return { id: created._id, created: true };
  } catch (err) {
    if (isDuplicateKey(err) && email) {
      const again = await Customer.findOne({ orgId, email })
        .select({ _id: 1 })
        .lean<{ _id: Types.ObjectId } | null>();
      if (again) return { id: again._id, created: false };
    }
    throw err;
  }
}

async function main(): Promise<void> {
  await connectMongo();
  await ensureIndexes();

  const summary: Summary = {
    ordersScanned: 0,
    ordersLinked: 0,
    customersCreated: 0,
    customersRecounted: 0,
  };

  // ── Phase A: link unlinked orders ──────────────────────────────────────
  console.log("→ Phase A: linking orders to Client Profiles…");
  const orderCursor = Order.find({
    orgId: { $exists: true, $ne: null },
    $or: [{ customerId: null }, { customerId: { $exists: false } }],
  })
    .select({ orgId: 1, customer: 1 })
    .cursor();

  for await (const order of orderCursor) {
    summary.ordersScanned += 1;
    if (!order.orgId) continue;
    const email = (order.customer?.email ?? "").toLowerCase().trim();
    const phone = (order.customer?.phone ?? "").trim();
    const name = order.customer?.name ?? "";
    const resolved = await resolveCustomerId(order.orgId, name, email, phone);
    if (!resolved) continue;
    if (resolved.created) summary.customersCreated += 1;
    await Order.updateOne(
      { _id: order._id },
      { $set: { customerId: resolved.id } },
    );
    summary.ordersLinked += 1;
    if (summary.ordersScanned % 500 === 0) {
      console.log(`  …${summary.ordersScanned} scanned, ${summary.ordersLinked} linked`);
    }
  }
  console.log(
    `  ✓ Phase A: ${summary.ordersLinked} linked, ${summary.customersCreated} profiles created`,
  );

  // ── Phase B: rebuild counters from orders ──────────────────────────────
  console.log("→ Phase B: rebuilding customer counters…");
  const customerCursor = Customer.find({}).select({ _id: 1, orgId: 1 }).cursor();
  for await (const c of customerCursor) {
    const [agg] = await Order.aggregate<{
      count: number;
      first: Date | null;
      last: Date | null;
    }>([
      {
        $match: {
          orgId: c.orgId,
          customerId: c._id,
          state: { $ne: RecordState.ARCHIVED },
        },
      },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          first: { $min: "$createdAt" },
          last: { $max: "$createdAt" },
        },
      },
    ]);
    await Customer.updateOne(
      { _id: c._id },
      {
        $set: {
          ordersCount: agg?.count ?? 0,
          firstOrderAt: agg?.first ?? null,
          lastOrderAt: agg?.last ?? null,
        },
      },
    );
    summary.customersRecounted += 1;
  }
  console.log(`  ✓ Phase B: ${summary.customersRecounted} customers recounted`);

  console.log("\n=== Migration summary ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log(
    "\nDone. Verify:\n" +
      "  db.orders.countDocuments({ orgId: { $ne: null }, customerId: null })\n" +
      "  (should be ~0 — any residual are orders with neither email nor phone)\n",
  );
}

main()
  .then(() => disconnectMongo())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Migration failed:", err);
    disconnectMongo().finally(() => process.exit(1));
  });
