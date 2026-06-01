import {
  Schema,
  type HydratedDocument,
  type Model,
  type Types,
} from "mongoose";

import {
  AuditAction,
  AuditEntity,
  USER_ROLES,
  UserRole,
} from "@/lib/constants/enums";

const AUDIT_ACTIONS = Object.values(AuditAction);
const AUDIT_ENTITIES = Object.values(AuditEntity);

export interface AuditLogDoc {
  /** Tenant boundary. Nullable during the migration, null only for
   *  pre-migration rows. Cross-tenant audit views (platform-admin
   *  surfaces) bypass this; per-tenant admin pages must filter on it. */
  orgId?: Types.ObjectId | null;
  action: AuditAction;
  entityType: AuditEntity;
  entityId?: string | null;
  actor: {
    userId?: Types.ObjectId | null;
    name?: string | null;
    email?: string | null;
    role?: UserRole | null;
  };
  request: {
    ip?: string | null;
    userAgent?: string | null;
    requestId?: string | null;
  };
  metadata?: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export type AuditLogDocument = HydratedDocument<AuditLogDoc>;

const auditLogSchema = new Schema<AuditLogDoc>(
  {
    orgId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      default: null,
      index: true,
    },
    action: { type: String, enum: AUDIT_ACTIONS, required: true, index: true },
    entityType: {
      type: String,
      enum: AUDIT_ENTITIES,
      required: true,
      index: true,
    },
    entityId: { type: String, default: null, index: true, sparse: true },
    actor: {
      userId: {
        type: Schema.Types.ObjectId,
        ref: "User",
        default: null,
        index: true,
      },
      name: { type: String, default: null },
      email: { type: String, default: null, lowercase: true },
      role: { type: String, enum: USER_ROLES, default: null },
    },
    request: {
      ip: { type: String, default: null },
      userAgent: { type: String, default: null },
      requestId: { type: String, default: null },
    },
    metadata: { type: Schema.Types.Mixed, default: null },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "audit_logs",
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

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });
auditLogSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });
auditLogSchema.index(
  { orgId: 1, createdAt: -1 },
  { partialFilterExpression: { orgId: { $type: "objectId" } } },
);

import { registerModel } from "./register";
export const AuditLog: Model<AuditLogDoc> = registerModel<AuditLogDoc>(
  "AuditLog",
  auditLogSchema,
);
