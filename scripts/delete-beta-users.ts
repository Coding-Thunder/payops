/**
 * Delete ALL beta users: every beta_applications row plus any account/org
 * created by a beta activation (matched by activatedUserId AND by email).
 * Never touches admin_* collections (admin allow-list stays intact).
 *
 * DESTRUCTIVE + irreversible. Prints what it found, then requires --yes to
 * actually delete (a dry run otherwise).
 *
 * Usage:
 *   tsx --env-file=.env.prod scripts/delete-beta-users.ts          # dry run
 *   tsx --env-file=.env.prod scripts/delete-beta-users.ts --yes    # delete
 */

import mongoose from "mongoose";

async function main(): Promise<void> {
  const commit = process.argv.includes("--yes");
  await mongoose.connect(process.env.MONGODB_URI!, {
    dbName: process.env.MONGODB_DB || undefined,
    serverSelectionTimeoutMS: 15000,
  });
  const db = mongoose.connection.db!;

  const apps = await db.collection("beta_applications").find({}).toArray();
  console.log(`beta_applications found: ${apps.length}`);
  for (const a of apps) {
    console.log(
      `  - ${a.email} | ${a.status}${a.activatedUserId ? " | activatedUserId=" + a.activatedUserId : ""}`,
    );
  }

  const emails = apps.map((a) => a.email).filter(Boolean);
  const uidSet = new Set<string>();
  for (const a of apps) if (a.activatedUserId) uidSet.add(String(a.activatedUserId));
  for (const u of await db.collection("users").find({ email: { $in: emails } }).toArray()) {
    uidSet.add(String(u._id));
  }
  const uids = [...uidSet].map((id) => new mongoose.Types.ObjectId(id));
  console.log(`beta-created user accounts to delete: ${uids.length}`);

  if (!commit) {
    console.log("\nDRY RUN — nothing deleted. Re-run with --yes to delete.");
    await mongoose.disconnect();
    return;
  }

  const cols = await db.listCollections().toArray();
  const orgScoped: Record<string, number> = {};
  let orgs = 0, users = 0, members = 0;
  for (const uid of uids) {
    const owned = await db.collection("organizations").find({ ownerUserId: uid }).toArray();
    const orgIds = owned.map((o) => o._id);
    if (orgIds.length) {
      for (const { name } of cols) {
        if (name.startsWith("admin_")) continue; // never touch admin collections
        const r = await db.collection(name).deleteMany({ orgId: { $in: orgIds } }).catch(() => null);
        if (r?.deletedCount) orgScoped[name] = (orgScoped[name] || 0) + r.deletedCount;
      }
      orgs += (await db.collection("organizations").deleteMany({ _id: { $in: orgIds } })).deletedCount;
    }
    members += (await db.collection("org_members").deleteMany({ userId: uid })).deletedCount;
    users += (await db.collection("users").deleteOne({ _id: uid })).deletedCount;
  }
  const ba = await db.collection("beta_applications").deleteMany({});

  console.log(
    "\nDELETED:",
    JSON.stringify(
      { betaApplications: ba.deletedCount, users, organizations: orgs, org_members: members, orgScoped },
      null,
      2,
    ),
  );
  console.log("admin_users KEPT:", await db.collection("admin_users").countDocuments({}));
  await mongoose.disconnect();
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
