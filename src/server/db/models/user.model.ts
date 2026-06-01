import {
  Schema,
  Types,
  type HydratedDocument,
  type Model,
} from "mongoose";

import {
  RECORD_STATES,
  RecordState,
  USER_ROLES,
  UserRole,
} from "@/lib/constants/enums";

export interface UserDoc {
  name: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  status: RecordState;
  createdBy?: Types.ObjectId | null;
  lastLoginAt?: Date | null;
  /** Default organization a user lands in after login. Multi-org users
   *  will gain an org-switcher later; today every user has exactly one
   *  membership and this points at it. Nullable during the legacy →
   *  multi-tenant migration; required once the backfill completes. */
  primaryOrgId?: Types.ObjectId | null;
  /** External-auth bindings. Populated when the user signs in via a
   *  third-party identity provider (Firebase Auth today) so future
   *  sign-ins resolve to this Mongo User by the provider's stable id
   *  rather than by email, which lets the user later change their
   *  Firebase email without orphaning the row. */
  externalAuth?: {
    firebaseUid?: string | null;
  } | null;
  createdAt: Date;
  updatedAt: Date;
}

export type UserDocument = HydratedDocument<UserDoc>;

const userSchema = new Schema<UserDoc>(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 254,
      index: true,
    },
    passwordHash: { type: String, required: true, select: false },
    role: {
      type: String,
      enum: USER_ROLES,
      required: true,
      default: "STAFF",
    },
    status: {
      type: String,
      enum: RECORD_STATES,
      required: true,
      default: "ACTIVE",
      index: true,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    lastLoginAt: { type: Date, default: null },
    primaryOrgId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      default: null,
      index: true,
    },
    externalAuth: {
      type: new Schema(
        {
          firebaseUid: { type: String, default: null, sparse: true },
        },
        { _id: false },
      ),
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "users",
    toJSON: {
      transform(_doc, ret) {
        const r = ret as Record<string, unknown>;
        r.id = String(r._id);
        delete r._id;
        delete r.passwordHash;
        return r;
      },
    },
  },
);

// email already has `unique: true` on the field definition above, so no
// separate index call is needed - declaring both creates a duplicate-index
// warning at startup.
userSchema.index({ status: 1, role: 1 });
// Partial-unique on externalAuth.firebaseUid so the lookup path in
// firebaseExchange returns at most one row. Sparse so legacy users
// without Firebase linkage don't trip the unique constraint.
userSchema.index(
  { "externalAuth.firebaseUid": 1 },
  {
    unique: true,
    partialFilterExpression: {
      "externalAuth.firebaseUid": { $type: "string" },
    },
    name: "users_firebaseUid_unique",
  },
);

import { registerModel } from "./register";
export const User: Model<UserDoc> = registerModel<UserDoc>("User", userSchema);
