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
 * Knobs (env vars):
 *   BACKFILL_SERVICE_TYPE_APPLY   "true" to write. Anything else = dry run.
 *   BACKFILL_SERVICE_TYPE_BATCH   documents per batch (default 1000).
 *
 * WHY THIS IS NEEDED AT ALL, given the schema already defaults the field:
 *
 *   A Mongoose `default` is applied when a document is CREATED or HYDRATED,
 *   never to bytes already at rest. So every historical order validates and
 *   re-saves correctly with no backfill — reads are already right. What is
 *   NOT right without this script is QUERIES: `Order.find({ serviceType:
 *   "CAR_RENTAL" })` matches nothing on a document that has no such key, so
 *   an operator filtering by service type would see an empty list of their
 *   own history. (The application code compensates by writing that filter as
 *   `{ $in: ["CAR_RENTAL", null] }`, so correctness never depends on this
 *   script having run — only index-friendly query performance does.)
 *
 * RUN ORDER MATTERS: deploy the schema FIRST. Mongoose runs `strict: true`
 * on the Order schema, so a write issued before the field is declared would
 * be silently dropped.
 *
 * Properties this script is built to have — same contract as
 * `backfill-organization-id.ts`, which it is modelled on:
 *
 *   idempotent      it only ever matches documents where `serviceType` is
 *                   absent or null. A second run matches nothing.
 *   resumable       bounded batches keyed off the same filter, so an
 *                   interrupted run continues on the next invocation.
 *   non-destructive it adds one field. Nothing is deleted or overwritten —
 *                   an order that already carries a serviceType (including a
 *                   FLIGHT or HOTEL one) is never touched.
 *   reversible      the inverse is a single `$unset`, printed at the end.
 *
 * Writes go through the RAW DRIVER (`Order.collection`) rather than the
 * model, for the same reason the organization backfill does: it skips
 * validators and `timestamps`, so `updatedAt` is not churned across every
 * historical row. We are attributing history, not editing it.
 */

import type { ObjectId } from "mongodb";

import { connectMongo, disconnectMongo } from "../src/server/db/mongoose";
import { Order } from "../src/server/db/models";
import { ServiceType } from "../src/lib/constants/enums";

const APPLY = process.env.BACKFILL_SERVICE_TYPE_APPLY === "true";
const BATCH = Math.max(
  1,
  Number.parseInt(process.env.BACKFILL_SERVICE_TYPE_BATCH ?? "1000", 10) || 1000,
);

/** Matches ONLY rows that predate the field. */
const FILTER: Record<string, unknown> = {
  $or: [{ serviceType: { $exists: false } }, { serviceType: null }],
};

async function main() {
  console.log(
    `→ Backfilling orders.serviceType = ${ServiceType.CAR_RENTAL}${
      APPLY ? "" : " (dry run — set BACKFILL_SERVICE_TYPE_APPLY=true to write)"
    }`,
  );

  await connectMongo();
  const collection = Order.collection;

  const total = await collection.countDocuments({});
  const pending = await collection.countDocuments(FILTER);
  console.log(`  • orders total            ${total}`);
  console.log(`  • orders missing the field ${pending}`);

  if (pending === 0) {
    console.log("  ✓ nothing to do — every order already carries a serviceType");
    await disconnectMongo();
    return;
  }

  if (!APPLY) {
    console.log(
      `  • dry run: would set serviceType="${ServiceType.CAR_RENTAL}" on ${pending} document(s)`,
    );
    console.log("  • no writes made");
    await disconnectMongo();
    return;
  }

  let updated = 0;
  // Bounded batches rather than one unbounded updateMany, so a large
  // collection cannot hold a single write lock for minutes and an
  // interrupted run leaves a consistent, resumable state.
  for (;;) {
    const batch = await collection
      .find(FILTER)
      .project<{ _id: ObjectId }>({ _id: 1 })
      .limit(BATCH)
      .toArray();
    if (batch.length === 0) break;

    const res = await collection.updateMany(
      { _id: { $in: batch.map((d) => d._id) }, ...FILTER },
      { $set: { serviceType: ServiceType.CAR_RENTAL } },
    );
    updated += res.modifiedCount ?? 0;
    console.log(`  • batch of ${batch.length} → ${res.modifiedCount} updated`);
    if (batch.length < BATCH) break;
  }

  const remaining = await collection.countDocuments(FILTER);
  console.log(`  ✓ updated ${updated}, remaining without the field ${remaining}`);
  console.log("");
  console.log("  To reverse this backfill:");
  console.log(
    `    db.orders.updateMany({ serviceType: "${ServiceType.CAR_RENTAL}" }, { $unset: { serviceType: "" } })`,
  );
  console.log("");
  console.log(
    "  NOTE: production runs autoIndex:false. Create the new indexes with",
  );
  console.log("    npm run indexes:audit");
  console.log(
    "  (orders: { organizationId, serviceType, createdAt } and the sparse",
  );
  console.log("   { payment.capture.status, payment.capture.captureExpiresAt })");

  await disconnectMongo();
}

main().catch(async (err) => {
  console.error("serviceType backfill failed:", err);
  await disconnectMongo().catch(() => {});
  process.exit(1);
});
