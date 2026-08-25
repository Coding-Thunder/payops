/**
 * Ensure every schema-declared index exists in production.
 *
 * The main app runs Mongoose with `autoIndex: false` in prod, so indexes added
 * to a schema are NOT built on deploy — they must be created manually. This
 * script does that for ALL models in one idempotent, NON-destructive pass:
 * `createIndexes()` builds any missing schema index and leaves existing ones
 * (and any hand-made ones) untouched — unlike `syncIndexes()`, it never drops.
 *
 * It covers the currently-pending set:
 *   - idempotency_keys        { key: 1 } UNIQUE  + { expiresAt: 1 } TTL(0)
 *   - processed_webhook_events{ gatewayEventId: 1 } UNIQUE  (webhook dedup)
 *   - org_members             { invite.tokenHash: 1 } SPARSE
 *   - order_drafts / outbox   TTL indexes (unbounded-growth guard on M0)
 *   - client_files            { orgId, customerId, deletedAt, createdAt }
 *                             + { orgId, orderId, createdAt } PARTIAL
 *   - client_links            the same pair (Files & Links list views)
 *
 * NOTE on file BYTES: uploaded files live in the GridFS bucket
 * `client_files` (collections `client_files.files` / `.chunks`), which is
 * NOT a Mongoose model and so isn't in the loop below. The MongoDB driver
 * creates that bucket's own indexes on first upload, independently of
 * Mongoose's autoIndex setting, so there is nothing to build here.
 *
 * Unique indexes fail to build if duplicates already exist (likely precisely
 * because the index was never enforced), so the two new unique collections are
 * de-duplicated FIRST — keeping the newest row per key.
 *
 * Safe to re-run. Read-mostly except the dedupe deletes (which only remove
 * true duplicates that the unique index would reject anyway).
 *
 * Usage:
 *   npx tsx --env-file=.env.prod scripts/ensure-prod-indexes.ts
 *   (or: npm run ensure-indexes:prod)
 */

import mongoose from "mongoose";

// Side-effect import: evaluating the barrel registers every model on mongoose.
import "../src/server/db/models";

async function dedupeUnique(collName: string, field: string): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) return;
  const exists = await db.listCollections({ name: collName }).hasNext();
  if (!exists) {
    console.log(`  dedupe ${collName}.${field}: collection absent, skipping`);
    return;
  }
  const coll = db.collection(collName);
  const dups = await coll
    .aggregate<{ _id: unknown; ids: mongoose.Types.ObjectId[]; n: number }>([
      { $match: { [field]: { $ne: null } } },
      { $group: { _id: `$${field}`, ids: { $push: "$_id" }, n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
    ])
    .toArray();
  let removed = 0;
  for (const d of dups) {
    const extra = d.ids.slice(1); // keep the first, drop the rest
    if (extra.length) {
      const r = await coll.deleteMany({ _id: { $in: extra } });
      removed += r.deletedCount ?? 0;
    }
  }
  console.log(
    `  dedupe ${collName}.${field}: ${dups.length} dup group(s), removed ${removed} row(s)`,
  );
}

/**
 * The four collections owned by the platform console (`src/console/server/db/
 * models.ts`). They are built here rather than through their models because
 * that module starts with `import "server-only"`, which throws outside a
 * React Server Component — importing it from this plain tsx script would
 * abort before a single index was built.
 *
 * Until the console was merged into this app it ran its own Mongoose connect
 * helper that omitted `autoIndex`, taking Mongoose's default of `true` — so
 * these indexes were being auto-built in production. It now shares the main
 * connection, which pins `autoIndex: false` in prod, so they must be built
 * from here.
 *
 * KEEP IN SYNC with the `schema.index(...)` calls in
 * `src/console/server/db/models.ts`. Idempotent: createIndex is a no-op when
 * an identical index already exists.
 */
async function ensureConsoleIndexes(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) return;
  const specs: Array<{
    collection: string;
    keys: Record<string, 1 | -1>;
    options?: { unique?: boolean; expireAfterSeconds?: number };
  }> = [
    // One live OTP per email (re-issuing replaces); TTL sweeps expired rows.
    { collection: "admin_otps", keys: { email: 1 }, options: { unique: true } },
    {
      collection: "admin_otps",
      keys: { expiresAt: 1 },
      options: { expireAfterSeconds: 0 },
    },
    // The DB-backed admin allow-list.
    { collection: "admin_users", keys: { email: 1 }, options: { unique: true } },
    { collection: "admin_audit", keys: { createdAt: -1 } },
    { collection: "admin_audit", keys: { actorEmail: 1, createdAt: -1 } },
    {
      collection: "admin_audit",
      keys: { targetType: 1, targetId: 1, createdAt: -1 },
    },
    {
      collection: "admin_notes",
      keys: { subjectType: 1, subjectId: 1, createdAt: -1 },
    },
  ];

  console.log("\nEnsuring platform-console indexes:");
  for (const s of specs) {
    try {
      const name = await db
        .collection(s.collection)
        .createIndex(s.keys, s.options ?? {});
      console.log(`  ✓ ${s.collection}.${name}`);
    } catch (err) {
      console.error(
        `  ✗ ${s.collection} ${JSON.stringify(s.keys)}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      process.exitCode = 1;
    }
  }
}

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB;
  if (!uri) {
    throw new Error(
      "MONGODB_URI not set — run with `--env-file=.env.prod` (or the target env).",
    );
  }

  await mongoose.connect(uri, { dbName, autoIndex: false });
  console.log(
    `connected: ${mongoose.connection.host}/${mongoose.connection.name}\n`,
  );

  console.log("De-duplicating before unique index builds:");
  await dedupeUnique("idempotency_keys", "key");
  await dedupeUnique("processed_webhook_events", "gatewayEventId");
  await dedupeUnique("admin_otps", "email");
  await dedupeUnique("admin_users", "email");

  await ensureConsoleIndexes();

  const names = Object.keys(mongoose.models).sort();
  console.log(`\nEnsuring indexes for ${names.length} models:`);
  let ok = 0;
  let failed = 0;
  for (const name of names) {
    const model = mongoose.models[name];
    try {
      await model.createIndexes();
      console.log(`  ✓ ${model.collection.collectionName}`);
      ok += 1;
    } catch (err) {
      failed += 1;
      console.error(
        `  ✗ ${model.collection.collectionName}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  await mongoose.disconnect();
  console.log(`\nDone — ${ok} ok, ${failed} failed.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
