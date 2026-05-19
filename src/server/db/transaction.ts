import "server-only";

import mongoose, { type ClientSession } from "mongoose";

import { logger } from "@/lib/logger";
import { connectMongo } from "@/server/db/mongoose";

/**
 * Multi-write transaction helper.
 *
 * Wraps Mongo's `session.withTransaction()` so callers don't sprinkle
 * session lifecycle code around the codebase. Pass the `session` arg
 * through to every `.create([...], { session })` and
 * `.findOneAndUpdate(..., { session })` inside the callback.
 *
 * Test-mode fallback: `mongodb-memory-server` (single node) cannot
 * transact. When the integration harness sets
 * `PAYOPS_TEST_MODE=integration` we skip the session entirely and run
 * the callback directly — production (Atlas, replica-set) takes the
 * real transaction path. Same code path; the same code is tested.
 *
 * The callback receives `null` in test mode and a `ClientSession` in
 * prod. Helpers like `sessionOpt(session)` spread it onto SDK calls
 * defensively (`{ session: undefined }` instead of `{ session: null }`).
 */
export async function withTx<T>(
  fn: (session: ClientSession | null) => Promise<T>,
): Promise<T> {
  await connectMongo();

  if (transactionsDisabled()) {
    return fn(null);
  }

  const session = await mongoose.startSession();
  try {
    let captured: T | undefined;
    await session.withTransaction(async () => {
      captured = await fn(session);
    });
    return captured as T;
  } catch (err) {
    logger.error("tx.aborted", {
      err: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    await session.endSession();
  }
}

function transactionsDisabled(): boolean {
  if (process.env.PAYOPS_TEST_MODE === "integration") return true;
  if (process.env.PAYOPS_TX_DISABLED === "1") return true;
  return false;
}

/** Spread helper: `await Model.create([doc], sessionOpt(session))`. */
export function sessionOpt(
  session: ClientSession | null,
): { session: ClientSession } | undefined {
  return session ? { session } : undefined;
}

/**
 * Claim a gateway event id in the `ProcessedWebhookEvent` collection.
 * Returns true if this caller won the claim, false if another caller
 * (or a prior delivery) already claimed it.
 *
 * The unique index on `gatewayEventId` is the durable idempotency
 * primitive — webhook + reconcile collisions both race here and only
 * one wins. Lives in this module rather than the service layer so it
 * can be reused by any consumer that needs gateway-event dedupe.
 */
export async function tryClaimGatewayEvent(
  input: {
    gatewayEventId: string;
    gateway: string;
    orderId?: string | null;
  },
  session: ClientSession | null,
): Promise<boolean> {
  // Lazy import to break the module-graph cycle (models/index.ts pulls
  // in many models; this helper is upstream of services that pull in
  // models). Runtime import is fine for a server-only module.
  const { ProcessedWebhookEvent } = await import(
    "@/server/db/models/outbox.model"
  );
  try {
    const res = await ProcessedWebhookEvent.findOneAndUpdate(
      { gatewayEventId: input.gatewayEventId },
      {
        $setOnInsert: {
          gatewayEventId: input.gatewayEventId,
          gateway: input.gateway,
          orderId: input.orderId ?? null,
          processedAt: new Date(),
        },
      },
      {
        upsert: true,
        new: false,
        ...sessionOpt(session),
      },
    );
    // `new: false` returns the PRE-upsert doc; `null` means nothing
    // existed before — we created it. A non-null result means it was
    // already there (duplicate).
    return res === null;
  } catch (err) {
    // The only expected error is a duplicate-key under racey concurrent
    // upserts; treat as "already claimed" — caller short-circuits as
    // duplicate.
    if (isDuplicateKeyError(err)) return false;
    throw err;
  }
}

function isDuplicateKeyError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: number };
  return e.code === 11000;
}
