/* eslint-disable no-console */
/**
 * Stamp `serviceType: "CAR_RENTAL"` onto every order written before that
 * field existed.
 *
 * Run (reports only, writes nothing):
 *   npm run backfill:service-type
 *
 * Apply for real:
 *   BACKFILL_SERVICE_TYPE_APPLY=true npm run backfill:service-type
 *
 * ═══ WHY THIS IS OPTIONAL, AND WHAT IT ACTUALLY FIXES ═══════════════════
 *
 * CORRECTNESS DOES NOT DEPEND ON IT. `serviceType` is declared
 * required-with-default, so Mongoose applies CAR_RENTAL when hydrating a
 * document that has no such key, and every read path additionally goes
 * through `serviceTypeOf()`, which defaults the same way for `.lean()`
 * results. An un-backfilled order therefore RENDERS correctly everywhere:
 * the detail card, the receipt, the evidence PDF, the checkout description.
 *
 * QUERY COMPLETENESS DOES. A stored document with no `serviceType` key is
 * not matched by `{ serviceType: "CAR_RENTAL" }`, so the service filter on
 * the orders list would silently omit it. The filter is written as
 * `{ $in: ["CAR_RENTAL", null] }` precisely so that omission cannot happen
 * before this script runs — but the `$in` cannot use the plain
 * `serviceType` index efficiently, so running this is what lets the index
 * do its job on a large collection.
 *
 * Properties:
 *   dry run default  the safe direction for anything touching every order.
 *   idempotent       filtered on `serviceType: { $exists: false }`, so a
 *                    second run matches nothing.
 *   non-destructive  sets ONE field on documents that have no value for it.
 *                    Never touches an order that already carries one, so an
 *                    operator cannot convert a flight into a car rental by
 *                    re-running this.
 *   timestamps off   `updatedAt` is a business fact about when the ORDER
 *                    changed. A schema backfill did not change the booking,
 *                    and moving every order to the top of a "recently
 *                    updated" view would be actively misleading.
 */

import { connectMongo, disconnectMongo } from "../src/server/db/mongoose";
import { Order } from "../src/server/db/models";
import { ServiceType } from "../src/lib/constants/enums";

const APPLY = process.env.BACKFILL_SERVICE_TYPE_APPLY === "true";

async function main() {
  console.log(
    `→ Backfilling order.serviceType${
      APPLY ? "" : " (dry run — pass BACKFILL_SERVICE_TYPE_APPLY=true to write)"
    }`,
  );

  await connectMongo();

  const filter = { serviceType: { $exists: false } } as const;
  const [missing, total] = await Promise.all([
    Order.countDocuments(filter),
    Order.countDocuments({}),
  ]);

  console.log(`  • orders total                 ${total}`);
  console.log(`  • orders with no serviceType   ${missing}`);

  if (missing === 0) {
    console.log("  ✓ nothing to do — every order already carries a value.");
    await disconnectMongo();
    return;
  }

  if (!APPLY) {
    console.log(
      `  • dry run: ${missing} order(s) would be stamped CAR_RENTAL. No writes made.`,
    );
    await disconnectMongo();
    return;
  }

  const res = await Order.updateMany(
    filter,
    { $set: { serviceType: ServiceType.CAR_RENTAL } },
    { timestamps: false },
  );

  console.log(`  ✓ stamped ${res.modifiedCount} order(s) as CAR_RENTAL`);

  const remaining = await Order.countDocuments(filter);
  if (remaining > 0) {
    // Concurrent writes during the run are the only way to get here, and
    // re-running is safe, so this is a warning rather than a failure.
    console.warn(
      `  ⚠ ${remaining} order(s) still have no serviceType — re-run to finish.`,
    );
  }

  console.log("✔ Backfill complete.");
  await disconnectMongo();
}

main().catch(async (err) => {
  console.error("Service-type backfill failed:", err);
  await disconnectMongo().catch(() => {});
  process.exit(1);
});
