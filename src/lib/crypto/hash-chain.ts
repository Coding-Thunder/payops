import { createHash } from "node:crypto";

import { canonicalJSON } from "./canonical";

export const GENESIS_PREVIOUS_HASH = "GENESIS";

export interface HashInputs {
  previousHash: string | null;
  orderId: string;
  sequence: number;
  eventType: string;
  occurredAt: Date;
  payload: unknown;
}

export interface ComputedHashes {
  snapshotHash: string;
  hash: string;
}

/**
 * Compute the snapshot and chain hashes for one evidence event.
 *
 * `snapshotHash` proves the payload is unchanged. `hash` chains the
 * event to its predecessor so any single in-place edit cascades into
 * every downstream hash and is caught by `verifyChain`.
 */
export function computeEvidenceHash(inputs: HashInputs): ComputedHashes {
  const snapshotHash = sha256(canonicalJSON(inputs.payload));
  const previous = inputs.previousHash ?? GENESIS_PREVIOUS_HASH;
  const hash = sha256(
    [
      previous,
      inputs.orderId,
      String(inputs.sequence),
      inputs.eventType,
      inputs.occurredAt.toISOString(),
      snapshotHash,
    ].join("|"),
  );
  return { snapshotHash, hash };
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
