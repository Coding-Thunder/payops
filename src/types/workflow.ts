/**
 * Client-safe workflow types.
 *
 * Mirrors the WorkflowDoc shape from the server model but stays free
 * of Mongoose so it can be imported into client bundles (admin
 * workflow builder, order detail page, etc.).
 */

export interface WorkflowStatusDTO {
  key: string;
  label: string;
  color: string;
  isInitial: boolean;
  isTerminal: boolean;
  isPaid: boolean;
  displayOrder: number;
}

export interface WorkflowTransitionDTO {
  id: string;
  fromKey: string;
  toKey: string;
  label: string;
  requiredPermission: string | null;
  automationTriggerKey: string | null;
}

export interface WorkflowDTO {
  id: string;
  orgId: string;
  name: string;
  statuses: WorkflowStatusDTO[];
  transitions: WorkflowTransitionDTO[];
  initialStatusKey: string;
  paymentSuccessStatusKey: string;
  paymentFailureStatusKey: string;
  version: number;
  updatedAt: string;
}

/** Result of validating a proposed status mutation. */
export interface WorkflowTransitionResolution {
  allowed: boolean;
  /** Matched transition spec if allowed. Null when allowed is false
   *  (no edge between from→to) or when the move is a no-op. */
  transition: WorkflowTransitionDTO | null;
  /** Reason copy for UI error display when allowed=false. */
  reason: string | null;
}
