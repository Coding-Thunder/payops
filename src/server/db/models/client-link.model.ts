import {
  Schema,
  type HydratedDocument,
  type Model,
  type Types,
} from "mongoose";

import type { ResourceActorType } from "@/lib/constants/client-resources";

import { registerModel } from "./register";

/**
 * An external resource attached to a client relationship.
 *
 * Links are NOT a lesser kind of file — they're the other half of the
 * product. Agencies ship final video through Drive, source files through
 * WeTransfer, prototypes through Figma, dashboards through their own
 * tools. Those resources are part of the client record even though the
 * bytes will never live here. TraceTxn stores the pointer and the
 * context, and nothing else: "Do not attempt to download or store the
 * external file."
 *
 * Same relationship model as ClientFile — mandatory `customerId`,
 * optional `orderId` — so one row surfaces in both Client Links and
 * Order Links without duplication.
 */
export interface ClientLinkDoc {
  orgId: Types.ObjectId;
  customerId: Types.ObjectId;
  orderId?: Types.ObjectId | null;
  orderNumber?: string | null;

  /** Operator-facing label, e.g. "Final Project Video". */
  name: string;
  /** Normalised absolute http(s) URL. */
  url: string;
  /** Hostname without `www.` — the raw domain. */
  host: string;
  /** Friendly provider name ("Google Drive") or the host when unknown. */
  source: string;
  description?: string | null;

  addedBy: {
    userId?: Types.ObjectId | null;
    name: string;
    actorType: ResourceActorType;
  };

  /** Email provenance — powers the "Shared via email" filter and the
   *  matching timeline event. */
  emailSendCount: number;
  lastEmailedAt?: Date | null;

  deletedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ClientLinkDocument = HydratedDocument<ClientLinkDoc>;

const addedBySchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    name: { type: String, required: true, maxlength: 200 },
    actorType: {
      type: String,
      enum: ["BUSINESS", "CLIENT"] satisfies ResourceActorType[],
      required: true,
      default: "BUSINESS",
    },
  },
  { _id: false },
);

const clientLinkSchema = new Schema<ClientLinkDoc>(
  {
    orgId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    customerId: {
      type: Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
      index: true,
    },
    orderId: { type: Schema.Types.ObjectId, ref: "Order", default: null },
    orderNumber: { type: String, default: null, maxlength: 64 },

    name: { type: String, required: true, trim: true, maxlength: 200 },
    url: { type: String, required: true, trim: true, maxlength: 2048 },
    host: { type: String, required: true, lowercase: true, maxlength: 255 },
    source: { type: String, required: true, maxlength: 120 },
    description: { type: String, default: null, maxlength: 1000, trim: true },

    addedBy: { type: addedBySchema, required: true },

    emailSendCount: { type: Number, required: true, default: 0, min: 0 },
    lastEmailedAt: { type: Date, default: null },

    deletedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "client_links",
  },
);

clientLinkSchema.index({ orgId: 1, customerId: 1, deletedAt: 1, createdAt: -1 });
clientLinkSchema.index(
  { orgId: 1, orderId: 1, createdAt: -1 },
  { partialFilterExpression: { orderId: { $type: "objectId" } } },
);

export const ClientLink: Model<ClientLinkDoc> = registerModel<ClientLinkDoc>(
  "ClientLink",
  clientLinkSchema,
);
