import "server-only";

import type { NextRequest } from "next/server";

import { IdempotencyKey } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";

/** How long a used key blocks a repeat. Ample for a UI retry/double-submit. */
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** Read the client-supplied Idempotency-Key header (bounded), or null. */
export function idempotencyKeyFrom(req: NextRequest): string | null {
  const raw = req.headers.get("idempotency-key");
  if (!raw) return null;
  const k = raw.trim().slice(0, 128);
  return k.length >= 8 ? k : null;
}

function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: number }).code === 11000
  );
}

/**
 * Run `fn` at most once per (route, key). The FIRST caller claims the key and
 * runs `fn`; a concurrent/retry caller with the same key collides on the
 * unique index and gets `onDuplicate()` instead of re-running — so a timeout
 * retry or double-submit can never fire the action (e.g. an email) twice.
 *
 * The claim is RELEASED if `fn` throws, so a genuinely-failed action can be
 * retried. When `key` is null (client sent no header) there is no dedup —
 * behaviour is unchanged, keeping the endpoints backward-compatible.
 */
export async function runIdempotent<T>(
  route: string,
  key: string | null,
  fn: () => Promise<T>,
  onDuplicate: () => Promise<T>,
): Promise<T> {
  if (!key) return fn();
  await connectMongo();
  const scoped = `${route}:${key}`;
  try {
    await IdempotencyKey.create({
      key: scoped,
      expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) return onDuplicate();
    throw err;
  }
  try {
    return await fn();
  } catch (err) {
    // Release the claim so a legitimate retry of a FAILED action can re-run.
    await IdempotencyKey.deleteOne({ key: scoped }).catch(() => {});
    throw err;
  }
}
