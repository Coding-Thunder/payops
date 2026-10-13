
/**
 * Enforce data retention windows from the Privacy Policy.
 *
 * Runs every retention purge in sequence (today: email logs >90 days,
 * general-enquiry quotations >180 days; security/abuse logs land here once
 * the persistent surface exists).
 * Idempotent, run as often as you like, the cutoff is computed from
 * the current wall clock so partial runs converge.
 *
 * Scheduled by `.github/workflows/retention.yml` — daily at 03:17 UTC, one
 * run at a time, manually runnable from the Actions tab. NOT by DigitalOcean
 * App Platform: its `jobs` component only supports deploy-lifecycle kinds
 * (PRE_DEPLOY / POST_DEPLOY / FAILED_DEPLOY) and has no cron scheduler, so
 * the platform the app runs on cannot run this daily.
 *
 * Run manually:
 *   npm run retention:prod              # env from the environment
 *   npm run retention                   # env from .env.local
 *
 * Both resolve to:
 *   tsx --require ./scripts/shim-server-only.cjs scripts/run-retention.ts
 *
 * Output is operator-readable lines + final summary. Exits non-zero
 * on any thrown error so a cron's failure-detection picks it up.
 */

import mongoose from "mongoose";

import { connectMongo } from "@/server/db/mongoose";
import {
  purgeOldEmailLogs,
  purgeOldEnquiries,
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

  const enquiries = await purgeOldEnquiries(startedAt);
  console.log(
    `  enquiries     : deleted ${enquiries.deleted} contact_sales row(s) older than ${enquiries.cutoff.toISOString()}`,
  );

  const security = await purgeOldSecurityLogs(startedAt);
  console.log(
    `  security logs : deleted ${security.deleted} row(s) (no-op until the surface lands)`,
  );

  const totalDeleted = email.deleted + enquiries.deleted + security.deleted;
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
