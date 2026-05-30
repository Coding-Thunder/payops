/* eslint-disable no-console */
/**
 * Dev-only cleanup: drops EVERY document from EVERY collection
 * EXCEPT `users` across one or more databases. Lists what's there
 * first, then deletes.
 *
 * Defaults: cleans both `payops` (legacy) and `tracetxn` (current)
 * databases on the cluster pointed at by MONGODB_URI (from
 * .env.local or .env.prod).
 *
 * Override with a CSV list as the first arg:
 *   npx tsx scripts/cleanup-prod-data.ts payops,tracetxn
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import mongoose from "mongoose";

const KEEP_COLLECTIONS = new Set<string>(["users"]);
const SYSTEM_DBS = new Set<string>(["admin", "local", "config"]);

function loadEnvLocal(): void {
  for (const file of [".env.local", ".env.prod"]) {
    try {
      const raw = readFileSync(resolve(process.cwd(), file), "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?(.*?)"?\s*$/i.exec(line);
        if (!m) continue;
        if (m[1].startsWith("#")) continue;
        if (!(m[1] in process.env)) {
          process.env[m[1]] = m[2];
        }
      }
      return;
    } catch {
      // try next
    }
  }
}

async function main() {
  loadEnvLocal();
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI not set in .env.local / .env.prod.");
    process.exit(2);
  }

  // Comma-separated list of DB names, or default pair.
  const dbList = (process.argv[2] ?? "payops,tracetxn")
    .split(",")
    .map((d) => d.trim())
    .filter((d) => d && !SYSTEM_DBS.has(d));

  console.log(`Cluster      : ${redactUri(uri)}`);
  console.log(`Databases    : ${dbList.join(", ")}`);
  console.log(`Preserving   : users`);
  console.log("");

  await mongoose.connect(uri);

  for (const dbName of dbList) {
    await cleanDb(dbName);
  }

  await mongoose.disconnect();
}

async function cleanDb(dbName: string): Promise<void> {
  const conn = mongoose.connection;
  const db = conn.useDb(dbName, { useCache: false }).db;
  if (!db) {
    console.log(`[${dbName}] no handle, skipping`);
    return;
  }

  let collections: { name: string }[];
  try {
    collections = await db.listCollections({}, { nameOnly: true }).toArray();
  } catch (err) {
    console.log(
      `[${dbName}] listCollections failed: ${err instanceof Error ? err.message : err}`,
    );
    return;
  }

  console.log(`──────── ${dbName} ────────`);
  if (collections.length === 0) {
    console.log("  (no collections)");
    console.log("");
    return;
  }

  // Discovery
  for (const c of collections) {
    try {
      const n = await db.collection(c.name).countDocuments({});
      const action = KEEP_COLLECTIONS.has(c.name) ? "KEEP" : "DROP";
      console.log(`  ${c.name.padEnd(32)} ${String(n).padStart(6)}  ${action}`);
    } catch {
      console.log(`  ${c.name.padEnd(32)}      ?  (skipped)`);
    }
  }
  console.log("");

  // Delete pass
  let totalDeleted = 0;
  for (const c of collections) {
    if (KEEP_COLLECTIONS.has(c.name)) continue;
    try {
      const r = await db.collection(c.name).deleteMany({});
      console.log(
        `  ${c.name.padEnd(32)} deleted ${String(r.deletedCount).padStart(6)}`,
      );
      totalDeleted += r.deletedCount;
    } catch (err) {
      console.log(
        `  ${c.name.padEnd(32)} (skipped: ${err instanceof Error ? err.message : err})`,
      );
    }
  }
  console.log(`  [${dbName}] total deleted: ${totalDeleted}`);
  console.log("");
}

function redactUri(uri: string): string {
  return uri.replace(/:\/\/[^@]+@/, "://****:****@");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
