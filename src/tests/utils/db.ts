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
  const collections = await mongoose.connection.db?.collections();
  if (!collections) return;
  await Promise.all(collections.map((c) => c.deleteMany({})));
}

/**
 * Strong-form reset used by Playwright global-setup. Drops the whole
 * database. Slower than `resetDatabase`, but guarantees a pristine state
 * including indexes — useful between full test runs.
 */
export async function dropDatabase(): Promise<void> {
  await ensureMongo();
  await mongoose.connection.dropDatabase();
}

/** Convenience accessors so tests don't need to import every model. */
export const models = { User, Order, Setting, AuditLog };
