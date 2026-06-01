import {
  Schema,
  type HydratedDocument,
  type Model,
  type Types,
} from "mongoose";

import { registerModel } from "./register";

/**
 * Per-tenant order workflow.
 *
 * Replaces the hardcoded `OrderStatus` enum and the implicit transition
 * logic baked into order.service.ts with a tenant-configurable graph:
 *
 *   - statuses[]   , node set (the "boxes")
 *   - transitions[], directed edges (allowed moves) with optional guards
 *   - initialStatusKey, entry point for a fresh order
 *
 * The platform ships ONE behavior on first access: a default workflow
 * mirroring the legacy enum (NOT_INITIATED → ... → PAID/FAILED) is
 * lazy-provisioned so tenants who never visit the workflow builder get
 * exactly today's behavior. Tenants that DO customize override that
 * default and the order service validates every status mutation
 * against THEIR graph.
 *
 * Why nested arrays instead of separate collections:
 *   - Reads are always "load the whole workflow for one org", one
 *     document fits cleanly under 16MB even with thousands of edges.
 *   - Atomicity: status + transition edits are inherently transactional
 *     (you can't add a transition that references a missing status).
 *     Single-doc updates keep that guarantee for free.
 *
 * Hard constraints (NOT tenant-configurable):
 *   - At least one initial status must exist.
 *   - Status keys must be unique within a workflow.
 *   - Every transition's from/to must reference an existing status key.
 *   - Webhook payment events always target the `paymentSuccessStatusKey`
 *     and `paymentFailureStatusKey` declared at the workflow level -
 *     so tenants control the names but the gateway integration still
 *     has a stable contract to write into.
 */

/** Status node. `key` is the stable identifier (used on Order.statusKey,
 *  in URLs, in audit rows); `label` is the human-facing display string
 *  (rendered in tables, status pills, customer emails).
 *
 *  Visual + semantic flags drive UI rendering without forcing tenants
 *  to write their own renderer per status. */
export interface WorkflowStatusSpec {
  key: string;
  label: string;
  /** Hex color used for status pills + Kanban columns. */
  color: string;
  /** True for the entry-state of a fresh order. Exactly one status per
   *  workflow MUST have this set. */
  isInitial: boolean;
  /** True for a terminal state (no outgoing transitions expected).
   *  Drives UI affordances ("can't edit a closed order") and reports
   *  ("show only open orders"). */
  isTerminal: boolean;
  /** True if the order is considered paid at this status. Used by
   *  reporting / analytics + the dashboard "revenue from PAID orders"
   *  rollup. A workflow can have multiple paid statuses (e.g.
   *  "PAID_PARTIAL", "PAID_FULL"). */
  isPaid: boolean;
  /** Display order in the workflow builder + the order table's filter
   *  dropdown. Ties broken by `key`. */
  displayOrder: number;
}

/** Edge in the workflow graph. */
export interface WorkflowTransitionSpec {
  /** Stable id so future automation rules / audit log entries can
   *  reference a specific transition even if from/to are renamed via
   *  the workflow builder. */
  id: string;
  fromKey: string;
  toKey: string;
  /** Human-facing button label (e.g. "Approve", "Mark Paid"). */
  label: string;
  /** Optional permission key the actor must hold to fire this
   *  transition. When null, any user with order:update can fire it. */
  requiredPermission: string | null;
  /** Optional automation hook label, the automation engine looks up
   *  rules whose trigger key matches. Not enforced today; reserved
   *  for the WHEN-status-changes-THEN-X rule engine in Phase 8. */
  automationTriggerKey: string | null;
}

export interface WorkflowDoc {
  orgId: Types.ObjectId;
  /** Workflow label, surfaced in the admin builder. One per org for
   *  now; future multi-workflow support (e.g. "rental" vs "service")
   *  will fan out off this same model. */
  name: string;
  statuses: WorkflowStatusSpec[];
  transitions: WorkflowTransitionSpec[];
  /** Status key a brand-new order lands in. Must reference a status
   *  with isInitial=true. */
  initialStatusKey: string;
  /** Status key Stripe / payment-webhook moves orders to on a
   *  successful payment. Tenant chooses the name; the platform
   *  always writes to whatever they map here. */
  paymentSuccessStatusKey: string;
  /** Status key on payment failure / cancellation. Tenant-chosen,
   *  platform-mapped. */
  paymentFailureStatusKey: string;
  /** Workflow schema version. Bumped only on breaking edits (status
   *  key rename, transition deletion); additive changes leave it
   *  alone. Stamped onto every Order at creation so reports can
   *  filter by "orders created under workflow vN". */
  version: number;
  createdBy?: Types.ObjectId | null;
  updatedBy?: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

export type WorkflowDocument = HydratedDocument<WorkflowDoc>;

const statusSpecSchema = new Schema<WorkflowStatusSpec>(
  {
    key: {
      type: String,
      required: true,
      trim: true,
      maxlength: 48,
      match: /^[A-Z][A-Z0-9_]{0,47}$/,
    },
    label: { type: String, required: true, trim: true, maxlength: 80 },
    color: {
      type: String,
      required: true,
      match: /^#[0-9A-Fa-f]{6}$/,
      default: "#6B7280",
    },
    isInitial: { type: Boolean, default: false },
    isTerminal: { type: Boolean, default: false },
    isPaid: { type: Boolean, default: false },
    displayOrder: { type: Number, required: true, default: 0 },
  },
  { _id: false },
);

const transitionSpecSchema = new Schema<WorkflowTransitionSpec>(
  {
    id: { type: String, required: true, trim: true, maxlength: 32 },
    fromKey: { type: String, required: true, trim: true, maxlength: 48 },
    toKey: { type: String, required: true, trim: true, maxlength: 48 },
    label: { type: String, required: true, trim: true, maxlength: 80 },
    requiredPermission: {
      type: String,
      default: null,
      trim: true,
      maxlength: 64,
    },
    automationTriggerKey: {
      type: String,
      default: null,
      trim: true,
      maxlength: 64,
    },
  },
  { _id: false },
);

const workflowSchema = new Schema<WorkflowDoc>(
  {
    orgId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    statuses: {
      type: [statusSpecSchema],
      required: true,
      validate: {
        validator: (arr: WorkflowStatusSpec[]) => arr.length > 0,
        message: "Workflow must have at least one status",
      },
    },
    transitions: { type: [transitionSpecSchema], default: [] },
    initialStatusKey: { type: String, required: true, trim: true, maxlength: 48 },
    paymentSuccessStatusKey: {
      type: String,
      required: true,
      trim: true,
      maxlength: 48,
    },
    paymentFailureStatusKey: {
      type: String,
      required: true,
      trim: true,
      maxlength: 48,
    },
    version: { type: Number, required: true, default: 1 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "workflows",
    toJSON: {
      transform(_doc, ret) {
        const r = ret as Record<string, unknown>;
        r.id = String(r._id);
        delete r._id;
        return r;
      },
    },
  },
);

// One workflow per org for now. The unique index protects against
// double-seed races AND prepares us for the future multi-workflow
// world (drop the unique, add an index on { orgId, name } instead).
workflowSchema.index({ orgId: 1 }, { unique: true, name: "workflow_orgId_unique" });

export const Workflow: Model<WorkflowDoc> = registerModel<WorkflowDoc>(
  "Workflow",
  workflowSchema,
);
