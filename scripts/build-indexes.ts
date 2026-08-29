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
  AuditLog,
  CarLink,
  Dispute,
  EmailTemplate,
  Order,
  OrderDraft,
  OrderEvidence,
  Organization,
  OrganizationCredential,
  OrganizationMember,
  PaymentConsent,
  PendingEmail,
  ProcessedWebhookEvent,
  Provider,
  Quotation,
} from "../src/server/db/models";

const APPLY = process.env.BUILD_INDEXES_APPLY === "true";

const as = (m: unknown) => m as Model<never>;

/** Default scope: only what this migration introduces. */
const DEFAULT_TARGETS: Record<string, Model<never>> = {
  Organization: as(Organization),
  OrganizationMember: as(OrganizationMember),
  OrganizationCredential: as(OrganizationCredential),
};

/**
 * The pre-existing collections that gained a sparse `organizationId` index
 * from `schema.plugin(organizationScope)`.
 *
 * Kept OUT of the default scope deliberately. These are hot, populated
 * collections — building an index on `orders` or `audit_logs` in production
 * is a real operation with real duration, and it should be a deliberate step
 * an operator takes knowingly, not a side effect of running the same command
 * that created three empty organization collections. Select with
 * BUILD_INDEXES_MODELS=SCOPED.
 */
const SCOPED_TARGETS: Record<string, Model<never>> = {
  Order: as(Order),
  OrderDraft: as(OrderDraft),
  OrderEvidence: as(OrderEvidence),
  PaymentConsent: as(PaymentConsent),
  Dispute: as(Dispute),
  CarLink: as(CarLink),
  Quotation: as(Quotation),
  AuditLog: as(AuditLog),
  EmailTemplate: as(EmailTemplate),
  PendingEmail: as(PendingEmail),
  ProcessedWebhookEvent: as(ProcessedWebhookEvent),
  // Not organization-scoped via the plugin — the provider catalog carries an
  // `organizationIds` ALLOW-LIST instead (empty = available to every
  // organization). Listed here so its two new indexes can be selected by
  // name; the collection is small, so building them is cheap.
  Provider: as(Provider),
};

const ALL_TARGETS = { ...DEFAULT_TARGETS, ...SCOPED_TARGETS };

function selectTargets(): Record<string, Model<never>> {
  const raw = process.env.BUILD_INDEXES_MODELS?.trim();
  if (!raw || raw.toUpperCase() === "DEFAULT") return DEFAULT_TARGETS;

  if (raw.toUpperCase() === "SCOPED") {
    console.log(
      "  ⚠ SCOPED — building the sparse organizationId index on populated",
    );
    console.log(
      "    collections. On a large orders/audit_logs this takes real time.",
    );
    return SCOPED_TARGETS;
  }

  if (raw.toUpperCase() === "ALL") {
    console.log(
      "  ⚠ ALL — organization collections plus every scoped collection.",
    );
    console.log(
      "    Note this still only creates indexes DECLARED IN THE SCHEMAS; it",
    );
    console.log(
      "    does not address the separate backlog of hand-built prod indexes.",
    );
    return ALL_TARGETS;
  }

  const names = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const picked: Record<string, Model<never>> = {};
  for (const n of names) {
    const found = ALL_TARGETS[n];
    if (!found) {
      throw new Error(
        `Unknown model "${n}". Known: ${Object.keys(ALL_TARGETS).join(", ")}`,
      );
    }
    picked[n] = found;
  }
  return picked;
}

/**
 * Which declared indexes are in scope for this run.
 *
 * SCOPED defaults to "organizationId", so selecting the scoped collections
 * builds the tenancy index and NOTHING ELSE on those hot tables. Without
 * this, asking for the one index this migration needs would also try to
 * build every other index the schema declares but production never had —
 * an unreviewed change to `orders` and `audit_logs` smuggled in as a side
 * effect. Override with BUILD_INDEXES_KEY_FILTER, or set it empty to lift
 * the restriction deliberately.
 */
function resolveKeyFilter(): string | null {
  const explicit = process.env.BUILD_INDEXES_KEY_FILTER;
  if (explicit !== undefined) return explicit.trim() || null;
  const raw = process.env.BUILD_INDEXES_MODELS?.trim().toUpperCase();
  return raw === "SCOPED" ? "organizationId" : null;
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
  const keyFilter = resolveKeyFilter();
  if (keyFilter) {
    console.log(`  • restricted to indexes whose key mentions "${keyFilter}"`);
  }

  let missingTotal = 0;
  let createdTotal = 0;
  let failedTotal = 0;

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

    const inScope = keyFilter
      ? desired.filter(([key]) => keySignature(key).includes(keyFilter))
      : desired;
    const missing = inScope.filter(
      ([key]) => !existingSigs.has(keySignature(key)),
    );

    for (const [key, options] of inScope) {
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
      // Create each index INDIVIDUALLY rather than calling
      // `model.createIndexes()`.
      //
      // That helper builds every index the schema declares, in one
      // all-or-nothing call. On a populated collection that is two distinct
      // hazards: it silently drags in unrelated declared-but-absent indexes
      // (this deployment has a backlog of those), and a single failure —
      // say a unique index that real duplicate data cannot satisfy — aborts
      // the batch, so the index you actually came to create never gets
      // built. Observed exactly that: an E11000 on `orderNumber_1` stopped
      // `organizationId_1` from being created at all.
      //
      // One call per index means one failure is reported and skipped
      // instead of poisoning the rest.
      for (const [key, options] of missing) {
        const sig = keySignature(key);
        try {
          await model.collection.createIndex(
            key as Record<string, 1 | -1>,
            (options ?? {}) as Record<string, unknown>,
          );
          createdTotal += 1;
          console.log(`    ✓ created { ${sig} }`);
        } catch (err) {
          failedTotal += 1;
          console.log(
            `    ✗ FAILED  { ${sig} } — ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
          );
        }
      }
    }
  }

  if (missingTotal === 0) {
    console.log("✔ All declared indexes in scope are present.");
  } else if (APPLY) {
    console.log(
      `✔ Created ${createdTotal} index(es)${failedTotal ? `, ${failedTotal} FAILED (see above)` : ""}.`,
    );
    if (failedTotal > 0) {
      console.log(
        "  ⚠ A failed unique index usually means the data violates it. Resolve",
      );
      console.log("    the duplicates, then re-run — this script is idempotent.");
    }
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
