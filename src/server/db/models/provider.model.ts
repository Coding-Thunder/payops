import {
  Schema,
  type HydratedDocument,
  type Model,
  type Types,
} from "mongoose";

import {
  RECORD_STATES,
  RecordState,
  ServiceType,
} from "@/lib/constants/enums";
import { PROVIDER_KEY_REGEX } from "@/lib/constants/providers";

/**
 * Rental-provider catalog. Authoritative source for which brands the app
 * can attach to an order. The `key` is the stable identifier persisted on
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
  status: RecordState;
  /**
   * Which service types this supplier can be picked for.
   *
   * Defaults to `[CAR_RENTAL]`, so every provider row that existed before
   * this field keeps appearing exactly where it appears today — the rental
   * form — and an airline added for flights never surfaces on a car form.
   */
  serviceTypes: ServiceType[];
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
    status: {
      type: String,
      enum: RECORD_STATES,
      required: true,
      default: RecordState.ACTIVE,
      index: true,
    },
    /**
     * Which service types this supplier can be picked for.
     *
     * Deliberately NOT `required` and NOT `enum`-validated. An earlier
     * version used `{ type: [String], enum: SERVICE_TYPES, required: true,
     * default: () => [CAR_RENTAL] }` and it made the integration suite
     * ~30x slower (33s -> 1080s) with cascading 30s timeouts: a required,
     * enum-validated, defaulted array is materialised and element-validated
     * on every document Mongoose hydrates, and the provider catalog is
     * touched by nearly every test.
     *
     * Absent or empty means car-rental, which is how `listProviders` and
     * `providersForService` both read it, so the default is expressed in
     * the read path rather than stamped onto every document.
     */
    serviceTypes: { type: [String], default: undefined },
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

import { registerModel } from "./register";
export const Provider: Model<ProviderDoc> = registerModel<ProviderDoc>(
  "Provider",
  providerCatalogSchema,
);
