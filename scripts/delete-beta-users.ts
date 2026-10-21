/**
 * Delete NAMED beta accounts: the selected beta_applications rows plus any
 * account/org their activation created. Never touches admin_* collections.
 *
 * DESTRUCTIVE + irreversible, so it is bounded three ways:
 *   1. An explicit selector is REQUIRED. There is no spelling of this command
 *      that means "everything". It used to read every row with `find({})` and
 *      end with `deleteMany({})` on beta_applications, so "purge these two
 *      testers" and "erase every beta record there has ever been" were the
 *      same invocation — and the second cannot be undone.
 *   2. Dry run unless --yes.
 *   3. Firebase identities are REPORTED, never deleted. Firebase deletion has
 *      no dry run and no undo, so it stays a human decision in the console.
 *      Saying nothing about them is what left purged users with a working
 *      password and no account — the orphan state behind a real support report.
 *
 * Addresses are not printed. Operator logs are aggregated and retained, and an
 * applicant's email does not belong in them; ids and counts identify rows well
 * enough to act on.
 *
 * Usage:
 *   tsx --env-file=.env.prod scripts/delete-beta-users.ts --email=a@b.test
 *   tsx --env-file=.env.prod scripts/delete-beta-users.ts --email=a@b.test --yes
 *   tsx --env-file=.env.prod scripts/delete-beta-users.ts --id=<appId>,<appId>
 */

import mongoose from "mongoose";

import {
  buildPurgePlan,
  describePlan,
  parseSelectors,
  type PurgeCandidate,
} from "@/server/ops/beta-purge-plan";

async function main(): Promise<void> {
  const commit = process.argv.includes("--yes");
  const selector = parseSelectors(process.argv.slice(2));
  await mongoose.connect(process.env.MONGODB_URI!, {
    dbName: process.env.MONGODB_DB || undefined,
    serverSelectionTimeoutMS: 15000,
  });
  const db = mongoose.connection.db!;

  const rows = await db.collection("beta_applications").find({}).toArray();
  const candidates: PurgeCandidate[] = rows.map((a) => ({
    id: String(a._id),
    email: String(a.email ?? ""),
    status: String(a.status ?? ""),
    activatedUserId: a.activatedUserId ? String(a.activatedUserId) : null,
  }));

  const plan = buildPurgePlan(candidates, selector);
  console.log(`beta_applications in database: ${candidates.length}`);
  console.log(describePlan(plan));
  if (plan.refusal) {
    await mongoose.disconnect();
    process.exitCode = 2;
    return;
  }
  for (const c of plan.selected) {
    // Id and status only — no address.
    console.log(`  - ${c.id} | ${c.status}${c.activatedUserId ? " | activated" : ""}`);
  }

  // Scoped to the PLAN, not to every row in the collection. Previously this
  // resolved uids from `apps` — the unfiltered find({}) — so the user and
  // organization deletes below reached accounts the operator never named.
  const emails = plan.selected.map((c) => c.email).filter(Boolean);
  const uidSet = new Set<string>();
  for (const c of plan.selected) {
    if (c.activatedUserId) uidSet.add(c.activatedUserId);
  }
  for (const u of await db
    .collection("users")
    .find({ email: { $in: emails } })
    .toArray()) {
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
  // Bounded to the selected rows. This line was `deleteMany({})`.
  const selectedIds = plan.selected.map((c) => new mongoose.Types.ObjectId(c.id));
  const ba = await db
    .collection("beta_applications")
    .deleteMany({ _id: { $in: selectedIds } });

  console.log(
    "\nDELETED:",
    JSON.stringify(
      { betaApplications: ba.deletedCount, users, organizations: orgs, org_members: members, orgScoped },
      null,
      2,
    ),
  );
  console.log("admin_users KEPT:", await db.collection("admin_users").countDocuments({}));
  console.log(
    `\nFIREBASE: ${plan.firebaseIdentitiesToRemoveManually.length} identity(ies) ` +
      "still exist and were NOT deleted. Remove them in the Firebase console " +
      "(Authentication -> Users), or those people keep a working password with " +
      "no account. The addresses are intentionally not printed here; they are " +
      "the ones you passed in --email=, and the selected application ids above " +
      "resolve to them.",
  );
  await mongoose.disconnect();
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
