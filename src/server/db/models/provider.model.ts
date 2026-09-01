import {
  Schema,
  type HydratedDocument,
  type Model,
  type Types,
} from "mongoose";

import {
  RECORD_STATES,
  RecordState,
  SERVICE_TYPES,
  ServiceType,
} from "@/lib/constants/enums";
import { PROVIDER_KEY_REGEX } from "@/lib/constants/providers";

/**
 * Supplier catalog — rental brands, airlines, cruise lines. Authoritative
 * source for which brands the app can attach to an order. The `key` is the stable identifier persisted on
 * order snapshots — never renamed, never reused.
 *
 * `status` drives availability:
 *   - ACTIVE   : visible in selectors, accepted on new orders
 *   - DISABLED : hidden from selectors, rejected on new orders, kept for history
 *   - ARCHIVED : soft-deleted; same as DISABLED but signals "won't come back"
 *
 * Hard-deletion is intentionally not supported — historical orders carry a
 * snapshot of (id, name, logo), and the catalog row preserves the canonical
 * brand metadata in case it's ever needed for re-issue / dispute evidence.
 */
export interface ProviderDoc {
  key: string;
  name: string;
  logo: string;
  primaryColor: string;
  onPrimaryColor: string;
  tagline: string;
  /**
   * Which service types this supplier can be attached to. Defaults to
   * `[CAR_RENTAL]`, so every provider row that existed before this field
   * keeps appearing exactly where it appears today — the car-rental form —
   * and an airline added for RCR Cruise never surfaces on a cruise form.
   */
  serviceTypes: ServiceType[];
  /**
   * Organizations allowed to use this supplier. EMPTY MEANS "EVERY
   * ORGANIZATION", which is precisely how the catalog behaved before this
   * field existed — so no existing row needs a backfill and the incumbent
   * brand loses no supplier.
   *
   * A non-empty list RESTRICTS. That is how RCR Cruise's airlines and cruise
   * lines stay out of the car-rental brand's catalog even though both
   * tenants share one `providers` collection in one database.
   */
  organizationIds: Types.ObjectId[];
  status: RecordState;
  sortOrder: number;
  createdBy?: Types.ObjectId | null;
  updatedBy?: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ProviderDocument = HydratedDocument<ProviderDoc>;

const providerCatalogSchema = new Schema<ProviderDoc>(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      maxlength: 32,
      match: PROVIDER_KEY_REGEX,
    },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    logo: { type: String, required: true, maxlength: 200 },
    primaryColor: {
      type: String,
      required: true,
      match: /^#[0-9A-Fa-f]{6}$/,
      default: "#1E3A8A",
    },
    onPrimaryColor: {
      type: String,
      required: true,
      match: /^#[0-9A-Fa-f]{6}$/,
      default: "#FFFFFF",
    },
    tagline: { type: String, default: "", maxlength: 140, trim: true },
    serviceTypes: {
      type: [String],
      enum: SERVICE_TYPES,
      required: true,
      // Thunk: a shared array literal would be mutated across documents.
      default: () => [ServiceType.CAR_RENTAL],
    },
    organizationIds: {
      type: [Schema.Types.ObjectId],
      ref: "Organization",
      required: true,
      // Thunk: a shared array literal would be mutated across documents.
      default: () => [],
    },
    status: {
      type: String,
      enum: RECORD_STATES,
      required: true,
      default: RecordState.ACTIVE,
      index: true,
    },
    sortOrder: { type: Number, required: true, default: 0, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "providers",
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

providerCatalogSchema.index({ status: 1, sortOrder: 1, name: 1 });
providerCatalogSchema.index({ serviceTypes: 1, status: 1, sortOrder: 1 });
// Serves "which suppliers may this organization use?". Sparse because the
// overwhelming majority of rows carry an empty list (= every organization).
providerCatalogSchema.index({ organizationIds: 1 }, { sparse: true });

import { registerModel } from "./register";
export const Provider: Model<ProviderDoc> = registerModel<ProviderDoc>(
  "Provider",
  providerCatalogSchema,
);
