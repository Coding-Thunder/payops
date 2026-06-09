import { CheckCircle2Icon, ShieldAlertIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { OrderEvidenceVerificationDTO } from "@/types";

interface IntegrityBadgeProps {
  verification: OrderEvidenceVerificationDTO;
}

const REASON_LABEL: Record<string, string> = {
  payload_tampered: "Payload tampered",
  hash_mismatch: "Hash mismatch",
  previous_hash_mismatch: "Chain link broken",
  sequence_gap: "Sequence gap",
};

/**
 * Renders the chain-integrity state next to the evidence header. A
 * "valid" chain means every event's recomputed hash matches storage AND
 * every event's previousHash matches the prior event's hash. Anything
 * else is rendered as a "Broken at #N" red badge with the failure
 * reason, that surface state alone is dispute-grade evidence the
 * record hasn't been tampered with.
 */
export function IntegrityBadge({ verification }: IntegrityBadgeProps) {
  if (verification.eventCount === 0) {
    return (
      <Badge variant="muted">
        <ShieldAlertIcon className="size-3" />
        No events recorded
      </Badge>
    );
  }
  if (verification.valid) {
    return (
      <Badge variant="success">
        <CheckCircle2Icon className="size-3" />
        Integrity valid
      </Badge>
    );
  }
  const reason =
    REASON_LABEL[verification.reason ?? ""] ?? "Chain broken";
  return (
    <Badge variant="destructive">
      <ShieldAlertIcon className="size-3" />
      {`${reason} at #${verification.brokenAtSequence ?? "?"}`}
    </Badge>
  );
}
