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

/**
 * Which users may act inside which organization, and in what capacity.
 *
 * This is the authorization boundary for multi-tenancy. The selected
 * organization arrives from the client as a cookie, which is a *hint* and
 * never an authority — every request re-resolves it against this
 * collection, so a forged or stale cookie naming an organization the user
 * has no row for is rejected rather than honoured.
 *
 * Why a separate collection instead of `user.organizationIds[]`:
 *   - a membership carries its own role, so the same person can be an
 *     ADMIN of one brand and STAFF of another. `User.role` is a single
 *     global role and cannot express that.
 *   - membership can be revoked (status DISABLED) while keeping the audit
 *     trail of who once had access, which an array element cannot do.
 *   - the (organizationId, userId) unique index makes "is this user a
 *     member?" a single indexed lookup instead of an array scan.
 *
 * During the migration every existing user receives an ACTIVE membership
 * of the default organization carrying their current global role, so
 * today's access is preserved exactly.
 */

export interface OrganizationMemberDoc {
  organizationId: Types.ObjectId;
  userId: Types.ObjectId;
  /**
   * Role *within this organization*. Seeded from the user's global
   * `User.role` during backfill so behaviour is unchanged, and free to
   * diverge afterwards.
   */
  role: UserRole;
  /** DISABLED revokes access without destroying the record. */
  status: RecordState;
  createdBy?: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

export type OrganizationMemberDocument =
  HydratedDocument<OrganizationMemberDoc>;

const organizationMemberSchema = new Schema<OrganizationMemberDoc>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
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
    },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "organization_members",
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

// One membership row per (organization, user). Also the index that serves
// the per-request "may this user act in this organization?" check.
organizationMemberSchema.index(
  { organizationId: 1, userId: 1 },
  { unique: true },
);

// Serves the org switcher: "which organizations can I see?"
organizationMemberSchema.index({ userId: 1, status: 1 });

import { registerModel } from "./register";
export const OrganizationMember: Model<OrganizationMemberDoc> =
  registerModel<OrganizationMemberDoc>(
    "OrganizationMember",
    organizationMemberSchema,
  );
