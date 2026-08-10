/* eslint-disable no-console */
/**
 * Attribute pre-migration records to the default organization.
 *
 * Run (reports only, writes nothing):
 *   tsx --env-file=.env.local scripts/backfill-organization-id.ts
 *
 * Apply for real:
 *   BACKFILL_ORG_APPLY=true tsx --env-file=.env.local scripts/backfill-organization-id.ts
 *
 * Knobs (env vars):
 *   BACKFILL_ORG_APPLY   "true" to write. Anything else = dry run.
 *   BACKFILL_ORG_SLUG    attribute to this organization instead of the one
 *                        flagged `isDefault`.
 *   BACKFILL_ORG_BATCH   documents per batch (default 1000).
 *   BACKFILL_ORG_ONLY    comma-separated collection names to limit the run.
 *
 * Properties this script is built to have:
 *
 *   idempotent      it only ever matches documents where `organizationId` is
 *                   absent or null, and sets it. A second run matches
 *                   nothing and reports zero.
 *   resumable       work happens in bounded batches keyed off the same
 *                   filter, so an interrupted run simply continues where it
 *                   stopped on the next invocation. No cursor state is kept.
 *   non-destructive it adds one field. Nothing is deleted, no collection is
 *                   dropped, no existing field is modified or overwritten.
 *   reversible      the inverse is a single `$unset` per collection; the
 *                   exact commands are printed at the end of an applied run.
 *
 * Writes go through the RAW DRIVER (`Model.collection`) rather than the
 * Mongoose model. That is required, not incidental: `order_evidence` is
 * append-only at the schema level — its `pre("findOneAndUpdate" |
 * "updateOne" | "updateMany")` hooks throw unconditionally — so a model-level
 * update would be refused. Going through the driver uniformly also skips
 * validators and `timestamps`, which is correct for a data migration: we are
 * attributing history, not editing it, and `updatedAt` must not be churned
 * across every historical row.
 */

import type { Collection, Document } from "mongodb";
import type { Types } from "mongoose";

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
  PaymentConsent,
  PendingEmail,
  ProcessedWebhookEvent,
  Quotation,
} from "../src/server/db/models";

const APPLY = process.env.BACKFILL_ORG_APPLY === "true";
const SLUG = process.env.BACKFILL_ORG_SLUG?.trim().toLowerCase();
const BATCH = Math.max(
  1,
  Number(process.env.BACKFILL_ORG_BATCH ?? 1000) || 1000,
);
const ONLY = process.env.BACKFILL_ORG_ONLY?.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Every organization-owned collection. Mirrors the models carrying
 * `schema.plugin(organizationScope)`.
 *
 * `email_templates` is deliberately ABSENT. A null organizationId there is
 * not an unattributed leftover — it is the shared deployment-wide default
 * that organizations fall back to when they have not overridden a template.
 * Attributing those rows to RentalConfirmation would silently remove the
 * fallback for every other organization.
 */
const TARGETS: { name: string; collection: () => Collection<Document> }[] = [
  { name: "orders", collection: () => Order.collection },
  { name: "order_drafts", collection: () => OrderDraft.collection },
  { name: "order_evidence", collection: () => OrderEvidence.collection },
  { name: "payment_consents", collection: () => PaymentConsent.collection },
  { name: "disputes", collection: () => Dispute.collection },
  { name: "car_links", collection: () => CarLink.collection },
  { name: "quotations", collection: () => Quotation.collection },
  { name: "audit_logs", collection: () => AuditLog.collection },
  { name: "pending_emails", collection: () => PendingEmail.collection },
  {
    name: "processed_webhook_events",
    collection: () => ProcessedWebhookEvent.collection,
  },
];

/** Matches only rows that have never been attributed. */
const UNATTRIBUTED = {
  $or: [{ organizationId: { $exists: false } }, { organizationId: null }],
};

async function main() {
  console.log(
    `→ Backfilling organizationId${APPLY ? "" : " (dry run — pass BACKFILL_ORG_APPLY=true to write)"}`,
  );

  await connectMongo();

  const org = await Organization.findOne(
    SLUG ? { slug: SLUG } : { isDefault: true },
  ).lean<{ _id: Types.ObjectId; slug: string; brandName: string } | null>();

  if (!org) {
    throw new Error(
      SLUG
        ? `No organization with slug "${SLUG}". Run scripts/seed-organizations.ts first.`
        : "No default organization found. Run scripts/seed-organizations.ts first.",
    );
  }
  console.log(`  • target: ${org.brandName} (${org.slug}, ${String(org._id)})`);

  const selected = ONLY
    ? TARGETS.filter((t) => ONLY.includes(t.name))
    : TARGETS;
  if (ONLY) {
    const unknown = ONLY.filter((n) => !TARGETS.some((t) => t.name === n));
    if (unknown.length) {
      throw new Error(`Unknown collection(s): ${unknown.join(", ")}`);
    }
  }

  let totalPending = 0;
  let totalWritten = 0;

  for (const target of selected) {
    const coll = target.collection();

    let pending: number;
    try {
      pending = await coll.countDocuments(UNATTRIBUTED);
    } catch {
      console.log(`  • ${target.name}: collection does not exist — skipped`);
      continue;
    }

    const total = await coll.estimatedDocumentCount();
    totalPending += pending;

    if (pending === 0) {
      console.log(
        `  • ${target.name}: nothing to do (${total} document(s), all attributed)`,
      );
      continue;
    }

    if (!APPLY) {
      console.log(
        `  – ${target.name}: ${pending} of ${total} document(s) WOULD be attributed`,
      );
      continue;
    }

    // Bounded batches: pick ids, then update exactly those. Re-reading the
    // same filter each round is what makes an interrupted run resumable
    // without tracking a cursor.
    let written = 0;
    for (;;) {
      const batch = await coll
        .find(UNATTRIBUTED, { projection: { _id: 1 } })
        .limit(BATCH)
        .toArray();
      if (batch.length === 0) break;

      const res = await coll.updateMany(
        { _id: { $in: batch.map((d) => d._id) } },
        { $set: { organizationId: org._id } },
      );
      written += res.modifiedCount;
      process.stdout.write(`\r  ✓ ${target.name}: ${written}/${pending}`);
    }
    process.stdout.write("\n");
    totalWritten += written;

    const left = await coll.countDocuments(UNATTRIBUTED);
    if (left !== 0) {
      console.log(
        `    ⚠ ${left} document(s) still unattributed — re-run to continue`,
      );
    }
  }

  if (!APPLY) {
    console.log(
      `  • dry run: ${totalPending} document(s) across ${selected.length} collection(s) would be attributed. No writes made.`,
    );
    await disconnectMongo();
    return;
  }

  console.log(`✔ Attributed ${totalWritten} document(s).`);
  console.log("");
  console.log("  To reverse this run:");
  for (const t of selected) {
    console.log(
      `    db.${t.name}.updateMany({ organizationId: ObjectId("${String(org._id)}") }, { $unset: { organizationId: "" } })`,
    );
  }

  await disconnectMongo();
}

main().catch(async (err) => {
  console.error("Backfill failed:", err);
  await disconnectMongo().catch(() => {});
  process.exit(1);
});
