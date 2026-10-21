import mongoose from "mongoose";

import { connectMongo } from "@/server/db/mongoose";
import {
  AuditLog,
  Order,
  Setting,
  User,
} from "@/server/db/models";

/**
 * Connect helper. Most integration tests call this in `beforeAll` after
 * the per-file env has been set by `integration.setup.ts`.
 */
export async function ensureMongo(): Promise<void> {
  await connectMongo();
}

/**
 * Wipes every collection without dropping indexes. Cheap to call between
 * tests; `integration.setup.ts` does it automatically in `afterEach` so
 * test bodies rarely need this.
 */
export async function resetDatabase(): Promise<void> {
  await ensureMongo();
  const db = mongoose.connection.db;
  if (!db) return;
  const collections = await db.collections();

  // Only sweep collections that actually hold something.
  //
  // This used to issue one `deleteMany({})` per collection unconditionally.
  // Most are empty in most tests, and `integration.setup.ts` also resets in
  // `afterEach`, so a single test paid two full sweeps across every
  // collection in the database — the overwhelming majority of them no-ops
  // that still cost a round trip each.
  //
  // `estimatedDocumentCount` reads collection metadata rather than scanning,
  // so the check is far cheaper than the delete it avoids. The semantics are
  // identical: a collection with no documents has nothing to delete. This is
  // a throughput change, not an isolation change — nothing is skipped that
  // would otherwise have been removed.
  //
  // Why it matters: under load these hooks were exceeding the 60s
  // `hookTimeout` and failing a different integration file on each run
  // (customers-lookup, email-template-org-isolation,
  // email-send-failure-contract — all hook timeouts, never assertions, all
  // passing in isolation).
  const counts = await Promise.all(
    collections.map(async (c) => [c, await c.estimatedDocumentCount()] as const),
  );
  await Promise.all(
    counts.filter(([, n]) => n > 0).map(([c]) => c.deleteMany({})),
  );
}

/**
 * Strong-form reset used by Playwright global-setup. Drops the whole
 * database. Slower than `resetDatabase`, but guarantees a pristine state
 * including indexes, useful between full test runs.
 */
export async function dropDatabase(): Promise<void> {
  await ensureMongo();
  await mongoose.connection.dropDatabase();
}

/** Convenience accessors so tests don't need to import every model. */
export const models = { User, Order, Setting, AuditLog };
