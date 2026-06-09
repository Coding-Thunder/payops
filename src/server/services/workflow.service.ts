import "server-only";

import { randomBytes } from "node:crypto";
import { Types } from "mongoose";

import { ValidationError, NotFoundError } from "@/lib/errors";
import {
  Workflow,
  type WorkflowDoc,
  type WorkflowStatusSpec,
  type WorkflowTransitionSpec,
} from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import type {
  WorkflowDTO,
  WorkflowStatusDTO,
  WorkflowTransitionDTO,
  WorkflowTransitionResolution,
} from "@/types/workflow";

/**
 * Workflow service.
 *
 * Owns the per-tenant order-lifecycle graph: read, edit, validate
 * transitions, and lazy-seed a sensible default for fresh tenants.
 *
 * Design rule: every consumer (order.service, webhook.service,
 * dashboard rollups, admin UI) reads through THIS service. Direct
 * `Workflow.findOne(...)` calls from outside this file are a code
 * smell, they bypass the seed-on-miss + DTO normalisation here.
 */

// ──────────────────────────────────────────────────────────────────
// Default workflow (back-compat: mirrors the legacy OrderStatus enum)
// ──────────────────────────────────────────────────────────────────

/**
 * The single workflow we seed for every fresh tenant. Mirrors the
 * legacy hardcoded `OrderStatus` enum 1:1 so:
 *   - existing service code that checks `statusKey === "PAID"` keeps
 *     working without a migration,
 *   - the dashboard's revenue rollup ("count PAID orders") still
 *     hits the right state,
 *   - any tenant that NEVER opens the workflow builder sees today's
 *     behavior unchanged.
 *
 * Tenants that DO customize override these, the field names below
 * are seed defaults, not platform invariants.
 */
const DEFAULT_STATUSES: WorkflowStatusSpec[] = [
  {
    key: "NOT_INITIATED",
    label: "Draft",
    color: "#94A3B8",
    isInitial: true,
    isTerminal: false,
    isPaid: false,
    displayOrder: 1,
  },
  {
    key: "LINK_GENERATED",
    label: "Payment link ready",
    color: "#0EA5E9",
    isInitial: false,
    isTerminal: false,
    isPaid: false,
    displayOrder: 2,
  },
  {
    key: "PAYMENT_PENDING",
    label: "Payment pending",
    color: "#F59E0B",
    isInitial: false,
    isTerminal: false,
    isPaid: false,
    displayOrder: 3,
  },
  {
    key: "PAID",
    label: "Paid",
    color: "#16A34A",
    isInitial: false,
    isTerminal: true,
    isPaid: true,
    displayOrder: 4,
  },
  {
    key: "FAILED",
    label: "Payment failed",
    color: "#DC2626",
    isInitial: false,
    isTerminal: true,
    isPaid: false,
    displayOrder: 5,
  },
  {
    key: "EXPIRED",
    label: "Expired",
    color: "#6B7280",
    isInitial: false,
    isTerminal: true,
    isPaid: false,
    displayOrder: 6,
  },
];

const DEFAULT_TRANSITIONS: WorkflowTransitionSpec[] = [
  {
    id: "t_init_link",
    fromKey: "NOT_INITIATED",
    toKey: "LINK_GENERATED",
    label: "Generate payment link",
    requiredPermission: "order:regenerate_link",
    automationTriggerKey: null,
  },
  {
    id: "t_link_pending",
    fromKey: "LINK_GENERATED",
    toKey: "PAYMENT_PENDING",
    label: "Send payment request",
    requiredPermission: "order:update",
    automationTriggerKey: null,
  },
  {
    id: "t_pending_paid",
    fromKey: "PAYMENT_PENDING",
    toKey: "PAID",
    label: "Mark paid",
    requiredPermission: null,
    automationTriggerKey: "payment.succeeded",
  },
  {
    id: "t_pending_failed",
    fromKey: "PAYMENT_PENDING",
    toKey: "FAILED",
    label: "Mark failed",
    requiredPermission: null,
    automationTriggerKey: "payment.failed",
  },
  {
    id: "t_pending_expired",
    fromKey: "PAYMENT_PENDING",
    toKey: "EXPIRED",
    label: "Mark expired",
    requiredPermission: null,
    automationTriggerKey: "payment.expired",
  },
];

function buildDefaultWorkflow(orgId: string): Omit<
  WorkflowDoc,
  "createdAt" | "updatedAt" | "createdBy" | "updatedBy"
> {
  return {
    orgId: new Types.ObjectId(orgId),
    name: "Default order workflow",
    statuses: DEFAULT_STATUSES,
    transitions: DEFAULT_TRANSITIONS,
    initialStatusKey: "NOT_INITIATED",
    paymentSuccessStatusKey: "PAID",
    paymentFailureStatusKey: "FAILED",
    version: 1,
  };
}

// ──────────────────────────────────────────────────────────────────
// DTO mapping
// ──────────────────────────────────────────────────────────────────

function toDTO(doc: WorkflowDoc & { _id: unknown }): WorkflowDTO {
  return {
    id: String(doc._id),
    orgId: String(doc.orgId),
    name: doc.name,
    statuses: doc.statuses.map(
      (s): WorkflowStatusDTO => ({
        key: s.key,
        label: s.label,
        color: s.color,
        isInitial: s.isInitial,
        isTerminal: s.isTerminal,
        isPaid: s.isPaid,
        displayOrder: s.displayOrder,
      }),
    ),
    transitions: doc.transitions.map(
      (t): WorkflowTransitionDTO => ({
        id: t.id,
        fromKey: t.fromKey,
        toKey: t.toKey,
        label: t.label,
        requiredPermission: t.requiredPermission,
        automationTriggerKey: t.automationTriggerKey,
      }),
    ),
    initialStatusKey: doc.initialStatusKey,
    paymentSuccessStatusKey: doc.paymentSuccessStatusKey,
    paymentFailureStatusKey: doc.paymentFailureStatusKey,
    version: doc.version,
    updatedAt: doc.updatedAt.toISOString(),
  };
}

// ──────────────────────────────────────────────────────────────────
// Lazy seed + read
// ──────────────────────────────────────────────────────────────────

/**
 * Return the workflow for an org, lazy-provisioning the default on
 * first access. Race-safe: the unique index on `orgId` ensures two
 * concurrent first-access calls don't produce duplicate workflows.
 */
export async function getOrCreateDefaultWorkflow(
  orgId: string,
): Promise<WorkflowDTO> {
  if (!Types.ObjectId.isValid(orgId)) {
    throw new ValidationError(`Invalid orgId: ${orgId}`);
  }
  await connectMongo();
  const filter = { orgId: new Types.ObjectId(orgId) };

  const existing = await Workflow.findOne(filter).lean<
    WorkflowDoc & { _id: unknown }
  >();
  if (existing) return toDTO(existing);

  try {
    const created = await Workflow.create(buildDefaultWorkflow(orgId));
    return toDTO(created.toObject() as WorkflowDoc & { _id: unknown });
  } catch (err) {
    // Concurrent seed race, re-read.
    if ((err as { code?: number }).code === 11000) {
      const raced = await Workflow.findOne(filter).lean<
        WorkflowDoc & { _id: unknown }
      >();
      if (raced) return toDTO(raced);
    }
    throw err;
  }
}

export async function getWorkflow(orgId: string): Promise<WorkflowDTO> {
  return getOrCreateDefaultWorkflow(orgId);
}

// ──────────────────────────────────────────────────────────────────
// Transition resolution
// ──────────────────────────────────────────────────────────────────

/**
 * Resolve whether moving an order from `fromKey` to `toKey` is allowed
 * under the org's workflow. Pure read, no mutation. Used by:
 *
 *   - order.service before persisting a status change
 *   - webhook.service before applying a gateway-driven status change
 *   - admin UI to render only the "next" buttons that are actually
 *     legal from the current state
 *
 * Returns the matched transition spec on success so callers can
 * enforce its `requiredPermission` against the actor's role.
 */
export async function resolveTransition(
  orgId: string,
  fromKey: string,
  toKey: string,
): Promise<WorkflowTransitionResolution> {
  const wf = await getOrCreateDefaultWorkflow(orgId);

  if (fromKey === toKey) {
    return {
      allowed: false,
      transition: null,
      reason: `Order is already in status "${fromKey}"`,
    };
  }

  const fromStatus = wf.statuses.find((s) => s.key === fromKey);
  if (!fromStatus) {
    return {
      allowed: false,
      transition: null,
      reason: `Unknown source status "${fromKey}"`,
    };
  }
  const toStatus = wf.statuses.find((s) => s.key === toKey);
  if (!toStatus) {
    return {
      allowed: false,
      transition: null,
      reason: `Unknown target status "${toKey}"`,
    };
  }

  const transition = wf.transitions.find(
    (t) => t.fromKey === fromKey && t.toKey === toKey,
  );
  if (!transition) {
    return {
      allowed: false,
      transition: null,
      reason: `No transition defined from "${fromStatus.label}" to "${toStatus.label}"`,
    };
  }

  return { allowed: true, transition, reason: null };
}

// ──────────────────────────────────────────────────────────────────
// Edits (admin builder hooks)
// ──────────────────────────────────────────────────────────────────

interface AddStatusInput {
  key: string;
  label: string;
  color?: string;
  isTerminal?: boolean;
  isPaid?: boolean;
}

export async function addStatus(
  orgId: string,
  input: AddStatusInput,
  actor: { id: string },
): Promise<WorkflowDTO> {
  await connectMongo();
  const wfDoc = await Workflow.findOne({ orgId: new Types.ObjectId(orgId) });
  if (!wfDoc) throw new NotFoundError("Workflow not found");

  if (wfDoc.statuses.some((s) => s.key === input.key)) {
    throw new ValidationError(`Status "${input.key}" already exists`);
  }
  const nextOrder =
    Math.max(0, ...wfDoc.statuses.map((s) => s.displayOrder)) + 1;
  wfDoc.statuses.push({
    key: input.key.toUpperCase(),
    label: input.label,
    color: input.color ?? "#6B7280",
    isInitial: false,
    isTerminal: input.isTerminal ?? false,
    isPaid: input.isPaid ?? false,
    displayOrder: nextOrder,
  });
  wfDoc.updatedBy = new Types.ObjectId(actor.id);
  await wfDoc.save();
  return toDTO(wfDoc.toObject() as WorkflowDoc & { _id: unknown });
}

interface AddTransitionInput {
  fromKey: string;
  toKey: string;
  label: string;
  requiredPermission?: string | null;
  automationTriggerKey?: string | null;
}

export async function addTransition(
  orgId: string,
  input: AddTransitionInput,
  actor: { id: string },
): Promise<WorkflowDTO> {
  await connectMongo();
  const wfDoc = await Workflow.findOne({ orgId: new Types.ObjectId(orgId) });
  if (!wfDoc) throw new NotFoundError("Workflow not found");

  const fromExists = wfDoc.statuses.some((s) => s.key === input.fromKey);
  const toExists = wfDoc.statuses.some((s) => s.key === input.toKey);
  if (!fromExists || !toExists) {
    throw new ValidationError(
      `Transition references missing status (${input.fromKey} → ${input.toKey})`,
    );
  }
  if (
    wfDoc.transitions.some(
      (t) => t.fromKey === input.fromKey && t.toKey === input.toKey,
    )
  ) {
    throw new ValidationError(
      `Transition ${input.fromKey} → ${input.toKey} already exists`,
    );
  }

  wfDoc.transitions.push({
    id: `t_${randomBytes(6).toString("hex")}`,
    fromKey: input.fromKey,
    toKey: input.toKey,
    label: input.label,
    requiredPermission: input.requiredPermission ?? null,
    automationTriggerKey: input.automationTriggerKey ?? null,
  });
  wfDoc.updatedBy = new Types.ObjectId(actor.id);
  await wfDoc.save();
  return toDTO(wfDoc.toObject() as WorkflowDoc & { _id: unknown });
}

/* ─────────────────── Edit / delete (safety-guarded) ──────────────────── */

interface EditStatusInput {
  label?: string;
  color?: string;
  isTerminal?: boolean;
  isPaid?: boolean;
}

/** Edit a status's display fields. The `key` is immutable, renaming a
 *  status would orphan every Order.status currently pointing at it.
 *  Operators who want a different key delete + recreate (which the UI
 *  blocks anyway, since the platform-required keys are referenced from
 *  payment mappings + transitions). */
export async function editStatus(
  orgId: string,
  statusKey: string,
  input: EditStatusInput,
  actor: { id: string },
): Promise<WorkflowDTO> {
  await connectMongo();
  const wfDoc = await Workflow.findOne({ orgId: new Types.ObjectId(orgId) });
  if (!wfDoc) throw new NotFoundError("Workflow not found");

  const status = wfDoc.statuses.find((s) => s.key === statusKey);
  if (!status) {
    throw new NotFoundError(`Status "${statusKey}" not found`);
  }

  if (input.label !== undefined) status.label = input.label;
  if (input.color !== undefined) status.color = input.color;
  if (input.isTerminal !== undefined) status.isTerminal = input.isTerminal;
  // isPaid toggle has financial implications, guard against turning
  // OFF the flag for the status currently mapped as payment-success;
  // that would silently drop paid orders from the dashboard rollup.
  if (input.isPaid !== undefined) {
    if (
      input.isPaid === false &&
      wfDoc.paymentSuccessStatusKey === statusKey
    ) {
      throw new ValidationError(
        `Cannot clear isPaid on "${statusKey}", it's the current payment-success target. Re-point payment mapping first.`,
      );
    }
    status.isPaid = input.isPaid;
  }

  wfDoc.updatedBy = new Types.ObjectId(actor.id);
  wfDoc.markModified("statuses");
  await wfDoc.save();
  return toDTO(wfDoc.toObject() as WorkflowDoc & { _id: unknown });
}

/** Delete a status. Refuses when the status is load-bearing:
 *  - referenced by a transition (would orphan the edge)
 *  - mapped as payment-success or payment-failure target
 *  - the workflow's initialStatusKey
 *  - the ONLY initial status remaining
 *
 *  This service does NOT check whether live orders are currently in
 *  this status, that's the route's job (it has access to Order
 *  models without dragging the import into the workflow service). */
export async function removeStatus(
  orgId: string,
  statusKey: string,
  actor: { id: string },
): Promise<WorkflowDTO> {
  await connectMongo();
  const wfDoc = await Workflow.findOne({ orgId: new Types.ObjectId(orgId) });
  if (!wfDoc) throw new NotFoundError("Workflow not found");

  const status = wfDoc.statuses.find((s) => s.key === statusKey);
  if (!status) throw new NotFoundError(`Status "${statusKey}" not found`);

  if (wfDoc.initialStatusKey === statusKey) {
    throw new ValidationError(
      `Cannot delete "${statusKey}", it's the workflow's initial status. Set a different initial status first.`,
    );
  }
  if (wfDoc.paymentSuccessStatusKey === statusKey) {
    throw new ValidationError(
      `Cannot delete "${statusKey}", it's the payment-success target. Re-point payment mapping first.`,
    );
  }
  if (wfDoc.paymentFailureStatusKey === statusKey) {
    throw new ValidationError(
      `Cannot delete "${statusKey}", it's the payment-failure target. Re-point payment mapping first.`,
    );
  }
  const referencingTransitions = wfDoc.transitions.filter(
    (t) => t.fromKey === statusKey || t.toKey === statusKey,
  );
  if (referencingTransitions.length > 0) {
    const labels = referencingTransitions.map((t) => t.label).join(", ");
    throw new ValidationError(
      `Cannot delete "${statusKey}", it's referenced by transition(s): ${labels}. Delete those first.`,
    );
  }

  wfDoc.statuses = wfDoc.statuses.filter((s) => s.key !== statusKey);
  wfDoc.updatedBy = new Types.ObjectId(actor.id);
  await wfDoc.save();
  return toDTO(wfDoc.toObject() as WorkflowDoc & { _id: unknown });
}

/** Delete a transition by id. Always safe, transitions are pure edges
 *  with no downstream references. */
export async function removeTransition(
  orgId: string,
  transitionId: string,
  actor: { id: string },
): Promise<WorkflowDTO> {
  await connectMongo();
  const wfDoc = await Workflow.findOne({ orgId: new Types.ObjectId(orgId) });
  if (!wfDoc) throw new NotFoundError("Workflow not found");
  const before = wfDoc.transitions.length;
  wfDoc.transitions = wfDoc.transitions.filter((t) => t.id !== transitionId);
  if (wfDoc.transitions.length === before) {
    throw new NotFoundError(`Transition "${transitionId}" not found`);
  }
  wfDoc.updatedBy = new Types.ObjectId(actor.id);
  await wfDoc.save();
  return toDTO(wfDoc.toObject() as WorkflowDoc & { _id: unknown });
}

/**
 * Update the payment-success / payment-failure status mappings. These
 * are what the webhook handler writes into, renaming a status without
 * updating the mapping would silently route payments to the wrong
 * state.
 */
export async function setPaymentStatusMapping(
  orgId: string,
  input: { paymentSuccessStatusKey: string; paymentFailureStatusKey: string },
  actor: { id: string },
): Promise<WorkflowDTO> {
  await connectMongo();
  const wfDoc = await Workflow.findOne({ orgId: new Types.ObjectId(orgId) });
  if (!wfDoc) throw new NotFoundError("Workflow not found");

  const successOk = wfDoc.statuses.some(
    (s) => s.key === input.paymentSuccessStatusKey,
  );
  const failureOk = wfDoc.statuses.some(
    (s) => s.key === input.paymentFailureStatusKey,
  );
  if (!successOk) {
    throw new ValidationError(
      `Unknown success status "${input.paymentSuccessStatusKey}"`,
    );
  }
  if (!failureOk) {
    throw new ValidationError(
      `Unknown failure status "${input.paymentFailureStatusKey}"`,
    );
  }
  // Success status must be flagged isPaid, otherwise the dashboard's
  // revenue rollup will silently exclude paid orders.
  const success = wfDoc.statuses.find(
    (s) => s.key === input.paymentSuccessStatusKey,
  )!;
  if (!success.isPaid) {
    throw new ValidationError(
      `Status "${input.paymentSuccessStatusKey}" must have isPaid=true to be used as the payment-success target`,
    );
  }
  wfDoc.paymentSuccessStatusKey = input.paymentSuccessStatusKey;
  wfDoc.paymentFailureStatusKey = input.paymentFailureStatusKey;
  wfDoc.updatedBy = new Types.ObjectId(actor.id);
  await wfDoc.save();
  return toDTO(wfDoc.toObject() as WorkflowDoc & { _id: unknown });
}
