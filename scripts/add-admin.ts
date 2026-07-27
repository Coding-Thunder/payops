/**
 * Add (or re-activate) an admin in the DB-backed allow-list (`admin_users`).
 *
 * Self-contained: reads MONGODB_URI / MONGODB_DB straight from the
 * environment and does a raw upsert, so it doesn't pull in either app's
 * env-validation schema.
 *
 * Usage:
 *   tsx --env-file=.env.prod scripts/add-admin.ts <email> [name] [OWNER|ADMIN]
 */

import mongoose from "mongoose";

async function main(): Promise<void> {
  const rawEmail = process.argv[2];
  if (!rawEmail) throw new Error("Usage: add-admin.ts <email> [name] [role]");
  const email = rawEmail.trim().toLowerCase();
  const name = (process.argv[3] ?? email.split("@")[0]).trim();
  const role = (process.argv[4] ?? "ADMIN").toUpperCase();
  if (role !== "OWNER" && role !== "ADMIN") {
    throw new Error("Role must be OWNER or ADMIN");
  }

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");
  const dbName = process.env.MONGODB_DB || undefined;

  await mongoose.connect(uri, { dbName, serverSelectionTimeoutMS: 15_000 });
  const now = new Date();
  const col = mongoose.connection.collection("admin_users");
  const res = await col.updateOne(
    { email },
    {
      $set: { email, name, role, status: "ACTIVE", updatedAt: now },
      $setOnInsert: {
        invitedByEmail: null,
        lastLoginAt: null,
        createdAt: now,
      },
    },
    { upsert: true },
  );

  const action =
    res.upsertedCount && res.upsertedCount > 0 ? "created" : "updated";
  console.log(`✓ admin ${action}: ${email} (${role}, ACTIVE)`);
  await mongoose.disconnect();
}

main()
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error("add-admin failed:", err instanceof Error ? err.message : err);
    try {
      await mongoose.disconnect();
    } catch {
      /* ignore */
    }
    process.exit(1);
  });
