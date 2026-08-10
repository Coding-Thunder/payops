/* eslint-disable no-console */
/**
 * Drop indexes that are actively WRONG for multi-tenancy.
 *
 * `build-indexes.ts` is deliberately additive — it never drops anything, on
 * the grounds that dropping is destructive and should be a separate, named
 * decision. This is that separate decision, and it is narrow on purpose:
 * every index listed below is named explicitly, and the script refuses to
 * touch anything else.
 *
 * Why any of this is needed. Production runs `autoIndex: false`, so its index
 * set is whatever accumulated over time rather than whatever the schema
 * currently says. On `email_templates` that left three constraints that
 * predate the organization column:
 *
 *   email_templates_key_version              unique (templateKey, version)
 *   email_templates_orgId_key_version_unique unique (orgId, templateKey, version)
 *   orgId_1                                  (orgId)
 *
 * The first enforces version uniqueness across ALL organizations, so the
 * second brand to author a template collides with the first brand's version 1
 * and the write fails. The other two index `orgId`, a field this schema has
 * never had — every document is missing it, so that "scoped" unique index
 * collapses to exactly the same global constraint as the first.
 *
 * The replacement (`email_templates_org_key_version`, on the real
 * `organizationId`) is created by build-indexes.ts.
 *
 * Run (reports only, writes nothing):
 *   node scripts/with-env.mjs npx tsx scripts/drop-obsolete-indexes.ts
 *
 * Apply for real:
 *   DROP_INDEXES_APPLY=true node scripts/with-env.mjs npx tsx scripts/drop-obsolete-indexes.ts
 *
 * Idempotent: an index that is already gone is reported and skipped.
 */

import { connectMongo, disconnectMongo } from "../src/server/db/mongoose";
import mongoose from "mongoose";

const APPLY = process.env.DROP_INDEXES_APPLY === "true";

/**
 * collection -> index names to drop. Named, never pattern-matched: a regex
 * here would eventually match an index someone built by hand for a slow
 * query, and dropping that is a production incident with no error message.
 */
const OBSOLETE: Record<string, string[]> = {
  email_templates: [
    "email_templates_key_version",
    "email_templates_orgId_key_version_unique",
    "orgId_1",
  ],
};

async function main() {
  await connectMongo();
  const db = mongoose.connection.db;
  if (!db) throw new Error("No database handle after connect");

  console.log(
    APPLY
      ? "▶ APPLY — obsolete indexes will be dropped"
      : "▶ DRY RUN — nothing will be dropped (set DROP_INDEXES_APPLY=true)",
  );
  console.log(`  database: ${db.databaseName}\n`);

  let dropped = 0;
  let missing = 0;
  let blocked = 0;

  for (const [collName, names] of Object.entries(OBSOLETE)) {
    const exists = await db.listCollections({ name: collName }).toArray();
    if (!exists.length) {
      console.log(`${collName}: collection does not exist — skipping`);
      continue;
    }
    const coll = db.collection(collName);
    const count = await coll.countDocuments();
    const present = new Set((await coll.indexes()).map((i) => i.name));

    console.log(`${collName} (${count} documents)`);
    for (const name of names) {
      if (!present.has(name)) {
        console.log(`  · ${name} — already absent`);
        missing++;
        continue;
      }
      // A populated collection may be RELYING on the old constraint to keep
      // its data unique. Dropping it then would be a silent correctness
      // change, so refuse and make a human decide.
      if (count > 0) {
        console.log(
          `  ⚠ ${name} — collection is NOT empty; refusing to drop automatically.`,
        );
        console.log(
          `      Verify no two rows share (templateKey, version) per organization first.`,
        );
        blocked++;
        continue;
      }
      if (!APPLY) {
        console.log(`  · ${name} — would drop`);
        continue;
      }
      await coll.dropIndex(name);
      console.log(`  ✓ ${name} — dropped`);
      dropped++;
    }
  }

  console.log(
    `\n${APPLY ? "dropped" : "would drop"}: ${APPLY ? dropped : "see above"} · already absent: ${missing} · blocked: ${blocked}`,
  );
  if (blocked > 0) process.exitCode = 1;
  await disconnectMongo();
}

main().catch(async (err) => {
  console.error(err);
  await disconnectMongo().catch(() => {});
  process.exit(1);
});
