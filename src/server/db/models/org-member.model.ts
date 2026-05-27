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
 * remove `User.role` — it stays as a fallback so existing RBAC code
 * continues working unmodified.
 */
export interface OrgMemberDoc {
  orgId: Types.ObjectId;
  userId: Types.ObjectId;
  role: UserRole;
  status: RecordState;
  invitedBy?: Types.ObjectId | null;
  joinedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type OrgMemberDocument = HydratedDocument<OrgMemberDoc>;

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

export const OrgMember: Model<OrgMemberDoc> = registerModel<OrgMemberDoc>(
  "OrgMember",
  orgMemberSchema,
);
