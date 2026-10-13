import "server-only";

import { AuditAction } from "@/lib/constants/enums";
import { GENERAL_ENQUIRY_SOURCE } from "@/lib/validation/quotation";
import { logger } from "@/lib/logger";
import { AuditLog, Quotation } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";

/**
 * Data-retention enforcement.
 *
 * Privacy Policy retention contract:
 *   - Account + workspace data       → lifetime of workspace (no purge)
 *   - Audit logs + evidence chain    → lifetime of workspace (no purge)
 *   - Billing records                → tax/accounting period (no purge yet)
 *   - Security + abuse logs          → up to 12 months (stub today; see
 *                                      `purgeOldSecurityLogs`)
 *   - Email delivery metadata        → up to 90 days  (THIS is what
 *                                      `purgeOldEmailLogs` enforces)
 *   - Contact-form enquiries         → 180 days (`purgeOldEnquiries`)
 *
 * The shape of every function here is "compute cutoff → deleteMany →
 * return count" so they're trivially composable from a single
 * scheduled runner (`scripts/run-retention.ts`).
 *
 * No transactions / no audit-of-the-purge today: retention deletes
 * are a privacy promise, recording who ran them at the row level would
 * defeat the purge. The runner's stdout + the logger.info lines are
 * the operational trail.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Email delivery / failure audit rows older than 90 days. Pure
 *  deliverability metadata, no operational meaning past that window. */
export const EMAIL_LOG_RETENTION_DAYS = 90;

/**
 * General-enquiry retention, in days. Must match the period stated in
 * § "How long we keep information" on /privacy — the policy and this
 * constant are one promise expressed twice, and the privacy page's audit
 * docblock points here.
 */
export const ENQUIRY_RETENTION_DAYS = 180;

export interface PurgeResult {
  /** Number of rows actually deleted. */
  deleted: number;
  /** Cutoff Date used for the filter. Surfaces in the runner output
   *  so the operator can verify the window matches their expectation. */
  cutoff: Date;
}

/**
 * Hard-delete `EMAIL_SENT` / `EMAIL_FAILED` audit rows older than the
 * configured window. Every other action type is left alone — most of
 * them are part of the lifetime-retained operational audit trail
 * (USER_CREATED, ORDER_*, EVIDENCE_CAPTURED, etc.).
 *
 * Idempotent on subsequent runs because we re-compute the cutoff
 * relative to `now`.
 */
export async function purgeOldEmailLogs(
  now: Date = new Date(),
): Promise<PurgeResult> {
  await connectMongo();
  const cutoff = new Date(now.getTime() - EMAIL_LOG_RETENTION_DAYS * DAY_MS);
  const res = await AuditLog.deleteMany({
    action: { $in: [AuditAction.EMAIL_SENT, AuditAction.EMAIL_FAILED] },
    createdAt: { $lt: cutoff },
  });
  const deleted = res.deletedCount ?? 0;
  logger.info("retention.email_logs_purged", {
    deleted,
    cutoffIso: cutoff.toISOString(),
  });
  return { deleted, cutoff };
}

/**
 * Hard-delete general-enquiry quotations older than the configured window.
 *
 * ── What this must never touch ──────────────────────────────────────────
 *
 * The `quotations` collection is shared. `source: "waitlist"` rows are beta
 * waitlist entries that `console/services/provision.ts` grants real tenants
 * from, and `console/services/metrics.ts` counts on the admin dashboard;
 * `landing` and `email_requirements` are legacy gateway-era leads nobody
 * agreed to delete. So the filter is an explicit EQUALITY on the one source
 * this retention promise covers — not a `$nin`, not a date-only sweep.
 * Narrowing by equality means a source added later is retained by default,
 * which is the safe direction for a destructive job.
 *
 * Beta applications live in their own `beta_applications` collection and are
 * not reachable from here at all.
 *
 * Idempotent on subsequent runs because the cutoff is recomputed from `now`.
 */
export async function purgeOldEnquiries(
  now: Date = new Date(),
): Promise<PurgeResult> {
  await connectMongo();
  const cutoff = new Date(now.getTime() - ENQUIRY_RETENTION_DAYS * DAY_MS);
  const res = await Quotation.deleteMany({
    source: GENERAL_ENQUIRY_SOURCE,
    createdAt: { $lt: cutoff },
  });
  const deleted = res.deletedCount ?? 0;
  // No enquiry content in the log line — a retention log that copies the PII
  // it just deleted defeats the purge.
  logger.info("retention.enquiries_purged", {
    deleted,
    cutoffIso: cutoff.toISOString(),
  });
  return { deleted, cutoff };
}

/**
 * Placeholder for the 12-month security/abuse log retention promise.
 *
 * We don't persist a dedicated security-log collection today (failed
 * logins flow into Firebase Auth's own logs; rate-limit hits land in
 * the in-process counter and never make it to Mongo). When a
 * persistent security-log surface lands in `auth.service` or
 * `proxy.ts`, this function becomes the place to purge it. Until
 * then it's a no-op so the runner can call it without conditional
 * logic.
 */
export async function purgeOldSecurityLogs(
  _now: Date = new Date(),
): Promise<PurgeResult> {
  // Intentionally a no-op today. Returns deleted=0 + an arbitrary
  // cutoff so the runner output reads consistently.
  return { deleted: 0, cutoff: new Date(0) };
}
