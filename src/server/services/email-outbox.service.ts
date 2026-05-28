import "server-only";

import { type ClientSession, Types } from "mongoose";

import { EmailKind, UserRole } from "@/lib/constants/enums";
import { logger } from "@/lib/logger";
import {
  Order,
  PendingEmail,
  PendingEmailStatus,
  type PendingEmailDoc,
} from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import { sessionOpt } from "@/server/db/transaction";

import { sendPaymentConfirmationEmail } from "./email.service";
import { getOrderById } from "./order.service";

/* ────────────────────────── Enqueue (called in-tx) ──────────────────────── */

interface EnqueueInput {
  orderId: string;
  kind: EmailKind;
  recipient: string;
  metadata?: Record<string, unknown> | null;
}

/**
 * Enqueue an email for post-commit delivery. MUST be called inside the
 * same `withTx` block that mutates the order/audit/evidence — if the
 * transaction aborts, the row never lands. The caller is expected to
 * pass the active mongoose `session`; pass `null` for non-tx callers.
 *
 * Kicks the in-process cron on first call so the loop survives idle
 * intervals without an external scheduler. Test-mode skips the cron
 * to keep test invocations hermetic.
 */
export async function enqueueEmail(
  input: EnqueueInput,
  session: ClientSession | null,
): Promise<void> {
  await connectMongo();
  await PendingEmail.create(
    [
      {
        orderId: new Types.ObjectId(input.orderId),
        kind: input.kind,
        recipient: input.recipient.toLowerCase(),
        status: PendingEmailStatus.PENDING,
        attempts: 0,
        nextAttemptAt: new Date(),
        metadata: input.metadata ?? null,
      },
    ],
    sessionOpt(session),
  );
  ensureBackgroundDrainer();
}

/* ──────────────────────── Post-commit & cron drain ──────────────────────── */

/**
 * Fire-and-forget drain triggered from a route handler AFTER its
 * response has been committed (typically via `setImmediate`). Best-effort
 * — if it fails, the periodic in-process drainer picks up the row.
 *
 * Skipped in test mode so tests can deterministically inspect the
 * PendingEmail row before any background work fires.
 */
export function kickPostCommitDrain(): void {
  if (process.env.TRACETXN_TEST_MODE) return;
  setImmediate(() => {
    drainOnePendingEmail().catch((err) => {
      logger.warn("email_outbox.post_commit_drain_failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    });
  });
}

const DRAIN_INTERVAL_MS = 60_000;
const MAX_ATTEMPTS = 5;

type CronGlobal = typeof globalThis & {
  __tracetxnOutboxCron?: NodeJS.Timeout;
};

function ensureBackgroundDrainer(): void {
  if (process.env.TRACETXN_TEST_MODE) return;
  const g = globalThis as CronGlobal;
  if (g.__tracetxnOutboxCron) return;
  g.__tracetxnOutboxCron = setInterval(() => {
    drainPendingEmails(20).catch((err) => {
      logger.warn("email_outbox.cron_drain_failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }, DRAIN_INTERVAL_MS);
  // Don't keep the process alive solely for this timer — let Node exit
  // naturally on shutdown rather than blocking. Some Node typings mark
  // `unref` as Node-only so guard for safety.
  const timer = g.__tracetxnOutboxCron as unknown as { unref?: () => void };
  if (typeof timer.unref === "function") timer.unref();
}

/** Exponential backoff with jitter: 30s, 2m, 8m, 32m, 2h. */
function nextBackoff(attempts: number): Date {
  const baseSec = Math.min(7_200, Math.pow(4, attempts) * 30);
  const jitterSec = Math.floor(Math.random() * (baseSec * 0.2));
  return new Date(Date.now() + (baseSec + jitterSec) * 1000);
}

/**
 * Claim ONE pending email and process it. Returns null if none pending.
 * The conditional findOneAndUpdate (PENDING → PROCESSING) is the lock
 * so two concurrent drainers can never grab the same row.
 */
export async function drainOnePendingEmail(): Promise<
  | { id: string; status: PendingEmailStatus }
  | null
> {
  await connectMongo();
  const claimed = await PendingEmail.findOneAndUpdate(
    {
      status: PendingEmailStatus.PENDING,
      nextAttemptAt: { $lte: new Date() },
    },
    {
      $set: { status: PendingEmailStatus.PROCESSING },
      $inc: { attempts: 1 },
    },
    { sort: { nextAttemptAt: 1 }, new: true },
  );
  if (!claimed) return null;

  try {
    await processPendingEmail(
      claimed as unknown as PendingEmailDoc & { _id: Types.ObjectId },
    );
    claimed.status = PendingEmailStatus.SENT;
    claimed.sentAt = new Date();
    claimed.lastError = null;
    await claimed.save();
    return { id: String(claimed._id), status: PendingEmailStatus.SENT };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("email_outbox.send_failed", {
      id: String(claimed._id),
      attempts: claimed.attempts,
      kind: claimed.kind,
      err: msg,
    });
    if (claimed.attempts >= MAX_ATTEMPTS) {
      claimed.status = PendingEmailStatus.FAILED;
      claimed.lastError = msg.slice(0, 2000);
      await claimed.save();
      return { id: String(claimed._id), status: PendingEmailStatus.FAILED };
    }
    claimed.status = PendingEmailStatus.PENDING;
    claimed.nextAttemptAt = nextBackoff(claimed.attempts);
    claimed.lastError = msg.slice(0, 2000);
    await claimed.save();
    return { id: String(claimed._id), status: PendingEmailStatus.PENDING };
  }
}

/**
 * Drain up to `max` rows sequentially. Sequential (not parallel) on
 * $5 tier — the SMTP pool has 3 connections so parallel gains are
 * modest, and serial keeps memory/CPU calm.
 */
export async function drainPendingEmails(
  max = 10,
): Promise<{
  processed: number;
  sent: number;
  failed: number;
  retried: number;
}> {
  let processed = 0;
  let sent = 0;
  let failed = 0;
  let retried = 0;
  for (let i = 0; i < max; i += 1) {
    const result = await drainOnePendingEmail();
    if (!result) break;
    processed += 1;
    if (result.status === PendingEmailStatus.SENT) sent += 1;
    else if (result.status === PendingEmailStatus.FAILED) failed += 1;
    else retried += 1;
  }
  return { processed, sent, failed, retried };
}

async function processPendingEmail(
  doc: PendingEmailDoc & { _id: Types.ObjectId },
): Promise<void> {
  // Re-render from current order state. We deliberately don't snapshot
  // the order at enqueue time — branding / template / customer-email
  // edits between enqueue and drain should appear in the actual send.
  const order = await fetchOrderForOutbox(String(doc.orderId));
  if (doc.kind === EmailKind.PAYMENT_CONFIRMATION) {
    await sendPaymentConfirmationEmail(order);
    // Mark the order so the UI timeline + DTO can show "confirmation
    // sent". Conditional on the field being null so re-drains (rare —
    // shouldn't happen given outbox status gating) can't ratchet
    // backwards.
    await Order.updateOne(
      {
        _id: doc.orderId,
        "payment.confirmationEmailSentAt": null,
      },
      { $set: { "payment.confirmationEmailSentAt": new Date() } },
    );
    return;
  }
  throw new Error(`Outbox does not handle email kind: ${doc.kind}`);
}

/** System-actor fetch — skips per-actor permission checks via a synthetic
 *  SUPER_ADMIN context. The outbox drainer is not a per-user request. */
async function fetchOrderForOutbox(orderId: string) {
  return getOrderById(orderId, {
    actor: {
      id: "system",
      name: "outbox",
      email: "system@tracetxn.local",
      role: UserRole.SUPER_ADMIN,
    },
  });
}

/** Test-only: clear the in-process drainer so subsequent test files
 *  don't inherit it (matters for parallel test workers). */
export function _stopDrainerForTests(): void {
  const g = globalThis as CronGlobal;
  if (g.__tracetxnOutboxCron) {
    clearInterval(g.__tracetxnOutboxCron);
    g.__tracetxnOutboxCron = undefined;
  }
}
