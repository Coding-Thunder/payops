import {
  Schema,
  type HydratedDocument,
  type Model,
  type Types,
} from "mongoose";

import {
  RECORD_STATES,
  RecordState,
  USER_ROLES,
  UserRole,
} from "@/lib/constants/enums";

import { registerModel } from "./register";

/**
 * Join row that grants a user a role inside a specific organization.
 *
 * Why this is its own collection (vs. an array on `User`):
 *   - users will eventually belong to multiple orgs (agency staff, support
 *     contractors). Embedding inflates the user doc and complicates RBAC
 *     queries.
 *   - per-org role can differ from any "platform role" we add later
 *     (e.g. Anthropic-side platform admins).
 *   - org member churn (invites, deactivations) doesn't touch the user
 *     doc itself, keeping the audit trail clean.
 *
 * Today every existing user gets exactly one OrgMember row pointing at
 * the legacy org with their pre-migration `User.role`. Phase 0 does NOT
 * remove `User.role`, it stays as a fallback so existing RBAC code
 * continues working unmodified.
 */
/**
 * Single-use team-invitation token, mirroring the beta-application invite
 * shape. The raw 32-byte token lives ONLY in the emailed /join link; we
 * store just its sha256 hash. Single-use (`usedAt`), expiring (`expiresAt`),
 * and bound to the pre-created User's email. Present only while an invite is
 * outstanding; null (and absent on legacy rows) once accepted or for members
 * who were never invited via this flow.
 */
export interface TeamInvite {
  tokenHash: string;
  expiresAt: Date;
  sentAt: Date | null;
  usedAt: Date | null;
}

export interface OrgMemberDoc {
  orgId: Types.ObjectId;
  userId: Types.ObjectId;
  role: UserRole;
  status: RecordState;
  /** Outstanding team invitation (null once accepted / never invited). */
  invite?: TeamInvite | null;
  /** Per-member permission model (MEMBERs only; OWNERs always have full
   *  control). "full" grants the whole member operational set; "custom"
   *  grants only the permission keys in `permissions`. Resolved into an
   *  effective set (minus the permanently-restricted list) by
   *  `resolveEffectivePermissions`. */
  permissionMode: "full" | "custom";
  /** Custom permission keys granted when `permissionMode === "custom"`.
   *  Always intersected with the member-allowed set + restricted set on
   *  read, so a stale/over-broad value can never escalate privileges. */
  permissions: string[];
  invitedBy?: Types.ObjectId | null;
  joinedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type OrgMemberDocument = HydratedDocument<OrgMemberDoc>;

const teamInviteSchema = new Schema<TeamInvite>(
  {
    tokenHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    sentAt: { type: Date, default: null },
    usedAt: { type: Date, default: null },
  },
  { _id: false },
);

const orgMemberSchema = new Schema<OrgMemberDoc>(
  {
    orgId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    role: {
      type: String,
      enum: USER_ROLES,
      required: true,
      default: UserRole.STAFF,
    },
    status: {
      type: String,
      enum: RECORD_STATES,
      required: true,
      default: RecordState.ACTIVE,
      index: true,
    },
    permissionMode: {
      type: String,
      enum: ["full", "custom"],
      required: true,
      default: "full",
    },
    permissions: { type: [String], default: () => [] },
    invite: { type: teamInviteSchema, default: null },
    invitedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    joinedAt: { type: Date, required: true, default: Date.now },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "org_members",
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

// One membership row per (org, user). Re-invites flip status back to
// ACTIVE rather than creating duplicates.
orgMemberSchema.index({ orgId: 1, userId: 1 }, { unique: true });
orgMemberSchema.index({ userId: 1, status: 1 });
// Team-invite activation looks a member up by the hashed token. Sparse so
// only outstanding invites carry an entry. Prod runs autoIndex:false — this
// index must be created manually; the app is correct without it (low-volume
// collection scan) but the lookup is O(scan) until it exists.
orgMemberSchema.index({ "invite.tokenHash": 1 }, { sparse: true });

export const OrgMember: Model<OrgMemberDoc> = registerModel<OrgMemberDoc>(
  "OrgMember",
  orgMemberSchema,
);
