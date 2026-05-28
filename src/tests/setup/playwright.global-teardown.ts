import path from "node:path";
import fs from "node:fs";

import mongoose from "mongoose";

import { loadEnvFile } from "./load-env";

/**
 * Playwright global teardown.
 *
 *   - Drops the tracetxn-smoke database so the next run starts clean.
 *   - Deletes the credentials file written by global setup.
 *
 * Defensive: refuses to drop anything if MONGODB_URI doesn't point at
 * tracetxn-smoke. This is the last guard against a misconfigured CI
 * accidentally targeting dev / prod.
 */

const CREDS_FILE = path.resolve(process.cwd(), "reports/.smoke-creds.json");

export default async function globalTeardown() {
  loadEnvFile(".env.smoke");

  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB;
  if (!uri?.includes("tracetxn-smoke")) return;

  try {
    await mongoose.connect(uri, {
      dbName,
      serverSelectionTimeoutMS: 5_000,
    });
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  } catch {
    /* best-effort teardown — CI run still passes */
  }

  try {
    fs.unlinkSync(CREDS_FILE);
  } catch {
    /* file may not exist */
  }
}
