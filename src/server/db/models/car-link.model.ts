import {
  Schema,
  type HydratedDocument,
  type Model,
  type Types,
} from "mongoose";

import { registerModel } from "./register";

/**
 * Workspace-wide car library. Captures the (make, type, public-image-URL)
 * triple agents reuse across orders. Selecting a row in the create-order
 * form auto-fills `vehicle.company`, `vehicle.type`, and `vehicle.imageUrl`.
 *
 * Soft-deleted via `active=false` so historical orders that referenced a
 * link keep rendering its label in audit logs / order details.
 */
export interface CarLinkDoc {
  carMake: string;
  carType: string;
  imageUrl: string;
  notes: string | null;

  createdBy: {
    userId: Types.ObjectId;
    name: string;
  };

  active: boolean;

  createdAt: Date;
  updatedAt: Date;
}

export type CarLinkDocument = HydratedDocument<CarLinkDoc>;

const creatorSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true, maxlength: 200 },
  },
  { _id: false },
);

const carLinkSchema = new Schema<CarLinkDoc>(
  {
    carMake: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
      index: true,
    },
    carType: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
      index: true,
    },
    imageUrl: {
      type: String,
      required: true,
      trim: true,
      maxlength: 2048,
    },
    notes: { type: String, default: null, maxlength: 500, trim: true },
    createdBy: { type: creatorSchema, required: true },
    active: { type: Boolean, required: true, default: true, index: true },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "car_links",
  },
);

// Compound search index — the selector greps over make + type.
carLinkSchema.index({ carMake: 1, carType: 1 });
// Dedupe protection: same make + type + imageUrl should never be
// inserted twice (case-insensitive collation makes the unique-check
// match user expectations).
carLinkSchema.index(
  { carMake: 1, carType: 1, imageUrl: 1 },
  {
    unique: true,
    collation: { locale: "en", strength: 2 },
    name: "carLinks_dedupe",
  },
);

export const CarLink: Model<CarLinkDoc> = registerModel<CarLinkDoc>(
  "CarLink",
  carLinkSchema,
);
