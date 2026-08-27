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
  /**
   * Keep this account out of the Team members list.
   *
   * VISIBILITY ONLY — it is not a permission, not a status, and not a
   * security boundary. The account authenticates, authorises, appears as an
   * audit actor and is fetchable by id exactly as before; the single thing
   * it changes is whether `listUsers()` returns the row.
   *
   * Absent on every document written before this field existed, which is
   * why the query filters on `$ne: true` rather than `false`.
   */
  hiddenFromTeamList?: boolean;
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
    hiddenFromTeamList: { type: Boolean, default: false },
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

import { registerModel } from "./register";
export const User: Model<UserDoc> = registerModel<UserDoc>("User", userSchema);
