
/**
 * Enforce data retention windows from the Privacy Policy.
 *
 * Runs every retention purge in sequence (today: email logs >90 days;
 * security/abuse logs land here once the persistent surface exists).
 * Idempotent, run as often as you like, the cutoff is computed from
 * the current wall clock so partial runs converge.
 *
 * Intended for a scheduled trigger:
 *   - DO App Platform → scheduled trigger every 24h
 *   - GitHub Action on a cron
 *   - Plain `cron` on a server
 *
 * Run manually (dry-run still hits Mongo to count, just doesn't write):
 *   npx tsx --require ./scripts/shim-server-only.cjs \
 *     scripts/run-retention.ts            # apply
 *
 * Output is operator-readable lines + final summary. Exits non-zero
 * on any thrown error so a cron's failure-detection picks it up.
 */

import mongoose from "mongoose";

import { connectMongo } from "@/server/db/mongoose";
import {
  purgeOldEmailLogs,
  purgeOldSecurityLogs,
} from "@/server/services/retention.service";

async function main(): Promise<void> {
  await connectMongo();
  const startedAt = new Date();
  console.log(`Retention run started at ${startedAt.toISOString()}`);
  console.log("");

  const email = await purgeOldEmailLogs(startedAt);
  console.log(
    `  email logs    : deleted ${email.deleted} row(s) older than ${email.cutoff.toISOString()}`,
  );

  const security = await purgeOldSecurityLogs(startedAt);
  console.log(
    `  security logs : deleted ${security.deleted} row(s) (no-op until the surface lands)`,
  );

  const totalDeleted = email.deleted + security.deleted;
  console.log("");
  console.log(
    `Done in ${Date.now() - startedAt.getTime()}ms. Total deleted: ${totalDeleted}.`,
  );
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
