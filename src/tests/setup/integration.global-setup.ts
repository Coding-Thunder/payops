import { MongoMemoryServer } from "mongodb-memory-server";

import { loadEnvFile } from "./load-env";

/**
 * Vitest global setup for the integration project.
 *
 * Boots a single in-memory MongoDB instance shared across every test file
 * in the run. Each test file gets its own logical database (assigned in
 * `integration.setup.ts`) so cross-file pollution is impossible without
 * paying for a full mongod boot per file.
 *
 * The Mongo URI is exported via `process.env.MONGODB_URI` so when the app
 * code calls `connectMongo()` later it picks up the in-memory server
 * transparently.
 */

let mongod: MongoMemoryServer | null = null;

export async function setup() {
  loadEnvFile(".env.test");
  process.env.TRACETXN_TEST_MODE = "integration";

  mongod = await MongoMemoryServer.create({
    binary: { version: "7.0.14" },
    instance: { dbName: "tracetxn-it-root" },
  });
  const uri = mongod.getUri();
  // Pass to per-file setup via env vars. `MONGODB_URI` is rewritten
  // per-file so test isolation is real, not just by convention.
  process.env.TRACETXN_IT_MONGO_URI = uri;
  process.env.MONGODB_URI = uri;
  process.env.MONGODB_DB = "tracetxn-it-root";
  process.env.TRACETXN_TEST_MODE = "integration";
}

export async function teardown() {
  if (mongod) {
    await mongod.stop({ doCleanup: true, force: true });
    mongod = null;
  }
}
