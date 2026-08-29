import {
  Schema,
  type HydratedDocument,
  type Model,
  type Types,
} from "mongoose";

import { registerModel } from "./register";

/**
 * Workspace-wide hotel catalog. The HOTEL equivalent of `car_links`, and
 * deliberately built to the same shape.
 *
 * WHY A CATALOG AT ALL, when flights deliberately have none: an operator
 * booking a flight types the airline and flight number straight onto the
 * order, because those differ every time. A hotel is the opposite — the
 * same property is booked over and over, carries descriptive content
 * (amenities, photos) that would be absurd to retype per order, and the
 * operator needs to SEARCH it before creating the order. Selecting a row
 * fills the order's `hotel` snapshot the way `car_links` fills `vehicle`.
 *
 * NOT ORGANIZATION-SCOPED, on purpose, and consistent with `car_links` —
 * see commit 4ee5690 "the car library is shared reference data, not
 * tenant-owned". The catalog is reference data about the world, not about
 * a tenant: the Hilton in Dubai is the same Hilton whichever brand books
 * it. Tenancy lives on the ORDER, which carries `organizationId`; a hotel
 * row grants no access to anything.
 *
 * Soft-deleted via `active=false` so historical orders that referenced a
 * row keep rendering its label in audit logs and order details — again the
 * `car_links` rule, and for the same dispute-evidence reason.
 */

/**
 * One image. An ARRAY of these rather than the single `imageUrl` string
 * `car_links` uses: a car needs one representative photo, a hotel listing
 * is not credible without several. Modelled as a subdocument rather than a
 * bare string array so a caption and an explicit order can be attached
 * without a later migration.
 */
export interface HotelImage {
  url: string;
  caption: string | null;
  /** Ascending. Ties broken by array position. */
  sortOrder: number;
}

export interface HotelLocation {
  city: string;
  country: string;
  /** Free-text street address. Empty when only the city is known. */
  address: string | null;
}

export interface HotelDoc {
  name: string;
  description: string | null;
  location: HotelLocation;
  /** Free-text amenity labels, e.g. "Pool", "Airport shuttle". */
  amenities: string[];
  images: HotelImage[];
  /** Optional operator-facing star rating, 1–5. Null when unrated. */
  starRating: number | null;
  notes: string | null;

  createdBy: {
    userId: Types.ObjectId;
    name: string;
  };

  active: boolean;

  createdAt: Date;
  updatedAt: Date;
}

export type HotelDocument = HydratedDocument<HotelDoc>;

const creatorSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true, maxlength: 200 },
  },
  { _id: false },
);

const hotelImageSchema = new Schema<HotelImage>(
  {
    url: {
      type: String,
      required: true,
      trim: true,
      maxlength: 2048,
    },
    caption: { type: String, default: null, trim: true, maxlength: 200 },
    sortOrder: { type: Number, required: true, default: 0 },
  },
  { _id: false },
);

const hotelLocationSchema = new Schema<HotelLocation>(
  {
    city: { type: String, required: true, trim: true, maxlength: 120 },
    country: { type: String, required: true, trim: true, maxlength: 80 },
    address: { type: String, default: null, trim: true, maxlength: 300 },
  },
  { _id: false },
);

const hotelSchema = new Schema<HotelDoc>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 160,
      index: true,
    },
    description: { type: String, default: null, trim: true, maxlength: 4000 },
    location: { type: hotelLocationSchema, required: true },
    amenities: {
      type: [String],
      required: true,
      // Thunk: a shared array literal would be mutated across documents.
      default: () => [],
    },
    images: {
      type: [hotelImageSchema],
      required: true,
      default: () => [],
    },
    starRating: { type: Number, default: null, min: 1, max: 5 },
    notes: { type: String, default: null, maxlength: 500, trim: true },
    createdBy: { type: creatorSchema, required: true },
    active: { type: Boolean, required: true, default: true, index: true },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "hotels",
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

// The selector greps over name + city.
hotelSchema.index({ name: 1, "location.city": 1 });
// Dedupe protection, mirroring `carLinks_dedupe`: the same property in the
// same city should never be inserted twice. Case-insensitive collation so
// the check matches what an operator would consider a duplicate.
hotelSchema.index(
  { name: 1, "location.city": 1, "location.country": 1 },
  {
    unique: true,
    collation: { locale: "en", strength: 2 },
    name: "hotels_dedupe",
  },
);

export const Hotel: Model<HotelDoc> = registerModel<HotelDoc>(
  "Hotel",
  hotelSchema,
);
