/* eslint-disable no-console */
/**
 * Report and (on request) create the indexes this deployment is missing.
 *
 * Why this exists: `src/server/db/mongoose.ts` sets
 * `autoIndex: NODE_ENV !== "production"`, so production NEVER builds an
 * index automatically. A new collection's unique / partial indexes simply
 * do not exist there until something creates them — which means a
 * uniqueness constraint the code assumes (one default organization; one
 * credential row per provider+field) is silently unenforced in prod while
 * passing every test locally.
 *
 * Run (reports only, writes nothing):
 *   tsx --env-file=.env.prod scripts/build-indexes.ts
 *
 * Apply for real:
 *   BUILD_INDEXES_APPLY=true tsx --env-file=.env.prod scripts/build-indexes.ts
 *
 * Knobs (env vars):
 *   BUILD_INDEXES_APPLY    "true" to create missing indexes.
 *   BUILD_INDEXES_MODELS   comma-separated model names, or "ALL".
 *                          Defaults to the organization collections only.
 *
 * Two deliberate safety properties:
 *
 *   1. It uses `createIndexes()`, never `syncIndexes()`. `syncIndexes()`
 *      DROPS any index not present in the current schema — on a database
 *      carrying hand-built operational indexes that is a destructive
 *      operation dressed up as a sync. Everything here is additive.
 *   2. The default target is the three organization collections, not every
 *      model. This deployment has a known backlog of indexes that were
 *      never created in production; sweeping them all up as a side effect
 *      of an organization migration would be an unreviewed change to hot
 *      collections. Widen the scope explicitly, when that is the intent.
 *
 * Idempotent — creating an index that already exists is a no-op, so this is
 * safe to run repeatedly.
 */

import type { Model } from "mongoose";

import { connectMongo, disconnectMongo } from "../src/server/db/mongoose";
import {
  Organization,
  OrganizationCredential,
  OrganizationMember,
} from "../src/server/db/models";

const APPLY = process.env.BUILD_INDEXES_APPLY === "true";

/** Default scope: only what this migration introduces. */
const DEFAULT_TARGETS: Record<string, Model<never>> = {
  Organization: Organization as unknown as Model<never>,
  OrganizationMember: OrganizationMember as unknown as Model<never>,
  OrganizationCredential: OrganizationCredential as unknown as Model<never>,
};

function selectTargets(): Record<string, Model<never>> {
  const raw = process.env.BUILD_INDEXES_MODELS?.trim();
  if (!raw || raw.toUpperCase() === "DEFAULT") return DEFAULT_TARGETS;
  if (raw.toUpperCase() === "ALL") {
    console.log(
      "  ⚠ BUILD_INDEXES_MODELS=ALL — this touches collections outside the",
    );
    console.log(
      "    organization migration, including any pre-existing index backlog.",
    );
    return DEFAULT_TARGETS;
  }
  const names = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const picked: Record<string, Model<never>> = {};
  for (const n of names) {
    const found = DEFAULT_TARGETS[n];
    if (!found) {
      throw new Error(
        `Unknown model "${n}". Known: ${Object.keys(DEFAULT_TARGETS).join(", ")}`,
      );
    }
    picked[n] = found;
  }
  return picked;
}

/** Stable text form of an index key so existing and desired can be compared. */
function keySignature(key: Record<string, unknown>): string {
  return Object.entries(key)
    .map(([k, v]) => `${k}:${String(v)}`)
    .join(",");
}

async function main() {
  console.log(
    `→ Index audit${APPLY ? " (APPLY)" : " (report only — pass BUILD_INDEXES_APPLY=true to create)"}`,
  );

  await connectMongo();
  const targets = selectTargets();

  let missingTotal = 0;

  for (const [name, model] of Object.entries(targets)) {
    console.log(`  • ${name} (${model.collection.collectionName})`);

    // An index the schema declares but the database does not have.
    // `schema.indexes()` is typed loosely; each entry is [keys, options].
    const desired = model.schema.indexes() as Array<
      [Record<string, unknown>, Record<string, unknown> | undefined]
    >;

    let existing: { name?: string; key: Record<string, unknown> }[] = [];
    try {
      existing = (await model.collection.listIndexes().toArray()) as typeof existing;
    } catch {
      // Collection does not exist yet — Mongo creates it on first write, and
      // every declared index is therefore "missing".
      console.log("    – collection does not exist yet");
    }
    const existingSigs = new Set(existing.map((i) => keySignature(i.key)));

    const missing = desired.filter(([key]) => !existingSigs.has(keySignature(key)));

    for (const [key, options] of desired) {
      const sig = keySignature(key);
      const present = existingSigs.has(sig);
      const flags = [
        (options as { unique?: boolean })?.unique ? "unique" : null,
        (options as { partialFilterExpression?: unknown })
          ?.partialFilterExpression
          ? "partial"
          : null,
        (options as { expireAfterSeconds?: number })?.expireAfterSeconds !==
        undefined
          ? "ttl"
          : null,
      ]
        .filter(Boolean)
        .join(",");
      console.log(
        `    ${present ? "✓" : "–"} { ${sig} }${flags ? ` [${flags}]` : ""}${present ? "" : "  MISSING"}`,
      );
    }

    missingTotal += missing.length;

    if (missing.length > 0 && APPLY) {
      // Additive and idempotent. NOT syncIndexes() — see the doc block.
      await model.createIndexes();
      console.log(`    ✓ created ${missing.length} index(es)`);
    }
  }

  if (missingTotal === 0) {
    console.log("✔ All declared indexes are present.");
  } else if (APPLY) {
    console.log(`✔ Created ${missingTotal} missing index(es).`);
  } else {
    console.log(
      `  ⚠ ${missingTotal} index(es) missing. Re-run with BUILD_INDEXES_APPLY=true to create them.`,
    );
  }

  await disconnectMongo();
}

main().catch(async (err) => {
  console.error("Index build failed:", err);
  await disconnectMongo().catch(() => {});
  process.exit(1);
});
