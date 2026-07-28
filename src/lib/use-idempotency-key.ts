import { useRef } from "react";

/**
 * A retry-stable idempotency key for a mutating action.
 *
 *   const idem = useIdempotencyKey();
 *   await api.post(url, body, { headers: { "Idempotency-Key": idem.take() } });
 *   idem.clear(); // on success only
 *
 * `take()` returns a UUID that PERSISTS across calls until `clear()` — so a
 * timeout retry or double-submit reuses the same key and the server dedups
 * instead of firing the action (e.g. an email) twice. Call `clear()` after a
 * SUCCESSFUL request so the next action gets a fresh key; leave it set on
 * failure so a genuine retry is recognised as the same intent.
 */
export function useIdempotencyKey() {
  const ref = useRef<string | null>(null);
  return {
    take(): string {
      if (!ref.current) ref.current = crypto.randomUUID();
      return ref.current;
    },
    clear(): void {
      ref.current = null;
    },
  };
}
