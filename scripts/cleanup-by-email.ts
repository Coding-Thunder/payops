 
/**
 * Dev-only cleanup: removes all records associated with a target
 * email across the user-data collections. Reads MONGODB_URI +
 * MONGODB_DB from .env.local.
 *
 * Safe to re-run — every delete is idempotent (filter-based).
 *
 * Usage:
 *   npx tsx scripts/cleanup-by-email.ts vinaymaheshwari35@gmail.com
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import mongoose from "mongoose";

function loadEnvLocal(): void {
  try {
    const raw = readFileSync(
      resolve(process.cwd(), ".env.local"),
      "utf8",
    );
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?(.*?)"?\s*$/i.exec(line);
      if (!m) continue;
      if (m[1].startsWith("#")) continue;
      if (!(m[1] in process.env)) {
        process.env[m[1]] = m[2];
      }
    }
  } catch {
    // .env.local missing — caller must provide MONGODB_URI in shell.
  }
}

async function main() {
  loadEnvLocal();
  const target = (process.argv[2] ?? "").trim().toLowerCase();
  if (!target || !target.includes("@")) {
    console.error("Usage: tsx scripts/cleanup-by-email.ts <email>");
    process.exit(2);
  }

  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB;
  if (!uri) {
    console.error("MONGODB_URI not set in .env.local or shell env.");
    process.exit(2);
  }

  console.log(`Target email : ${target}`);
  console.log(`Database     : ${dbName ?? "(default)"}`);
  console.log("");

  await mongoose.connect(uri, dbName ? { dbName } : undefined);
  const db = mongoose.connection.db;
  if (!db) throw new Error("mongoose: no db handle");

  const emailRegex = new RegExp(`^${escapeRegex(target)}$`, "i");

  // Find the user document(s) up front so downstream filters can pin
  // by userId in collections where the email isn't denormalised.
  const users = await db
    .collection("users")
    .find({ email: { $regex: emailRegex } })
    .toArray();

  console.log(`Users found  : ${users.length}`);
  if (users.length > 0) {
    for (const u of users) {
      console.log(
        `  - ${String(u._id)} · ${u.email} · orgIds=${(u.orgIds ?? []).map(String).join(",") || "—"}`,
      );
    }
  }
  console.log("");

  const userIds = users.map((u) => u._id as unknown);

  // Per-collection (name, filter) pairs.
  const targets: Array<{ name: string; filter: Record<string, unknown> }> = [
    // User-keyed
    { name: "users", filter: { email: { $regex: emailRegex } } },
    { name: "org_members", filter: { userId: { $in: userIds } } },
    {
      name: "orders",
      filter: {
        $or: [
          { "customer.email": { $regex: emailRegex } },
          { "createdBy.email": { $regex: emailRegex } },
          { "createdBy.userId": { $in: userIds } },
        ],
      },
    },
    {
      name: "order_drafts",
      filter: {
        $or: [
          { ownerId: { $in: userIds } },
          { "data.customer.email": { $regex: emailRegex } },
        ],
      },
    },
    {
      name: "customers",
      filter: { email: { $regex: emailRegex } },
    },
    {
      name: "quotations",
      filter: { workEmail: { $regex: emailRegex } },
    },
    {
      name: "audit_logs",
      filter: {
        $or: [
          { actorId: { $in: userIds } },
          { "actor.userId": { $in: userIds } },
        ],
      },
    },
    {
      name: "payment_consents",
      filter: { customerEmail: { $regex: emailRegex } },
    },
    {
      name: "order_evidence",
      filter: {
        $or: [
          { "refs.customerEmail": { $regex: emailRegex } },
          { "actor.email": { $regex: emailRegex } },
          { "actor.userId": { $in: userIds } },
        ],
      },
    },
    {
      name: "pending_emails",
      filter: {
        $or: [
          { to: { $regex: emailRegex } },
          { "envelope.to": { $regex: emailRegex } },
        ],
      },
    },
    {
      name: "disputes",
      filter: {
        $or: [
          { customerEmail: { $regex: emailRegex } },
          { "metadata.customerEmail": { $regex: emailRegex } },
        ],
      },
    },
    {
      name: "processed_webhook_events",
      filter: {},
      // Intentionally empty filter — we don't delete; just count.
      // Webhook dedupe records aren't user-keyed.
    },
  ];

  // Discovery pass — count what would be deleted.
  console.log("--- Discovery (counts before delete) ---");
  for (const t of targets) {
    if (Object.keys(t.filter).length === 0) continue;
    try {
      const n = await db.collection(t.name).countDocuments(t.filter);
      console.log(`  ${t.name.padEnd(28)} ${n}`);
    } catch (err) {
      console.log(
        `  ${t.name.padEnd(28)} (skipped: ${err instanceof Error ? err.message : err})`,
      );
    }
  }
  console.log("");

  // Delete pass.
  console.log("--- Deleting ---");
  let totalDeleted = 0;
  for (const t of targets) {
    if (Object.keys(t.filter).length === 0) continue;
    try {
      const r = await db.collection(t.name).deleteMany(t.filter);
      console.log(`  ${t.name.padEnd(28)} deleted ${r.deletedCount}`);
      totalDeleted += r.deletedCount;
    } catch (err) {
      console.log(
        `  ${t.name.padEnd(28)} (skipped: ${err instanceof Error ? err.message : err})`,
      );
    }
  }
  console.log("");
  console.log(`Total documents deleted: ${totalDeleted}`);

  await mongoose.disconnect();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
