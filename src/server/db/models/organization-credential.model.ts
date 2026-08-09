import {
  Schema,
  type HydratedDocument,
  type Model,
  type Types,
} from "mongoose";

/**
 * Encrypted per-organization secrets — Stripe secret key, Stripe webhook
 * signing secret, PayPal client secret, SMTP password.
 *
 * Deliberately a sibling collection rather than fields on `organizations`:
 *
 *   - `Organization.find()` is a routine query that will end up in list
 *     endpoints, admin screens, aggregations, and debug logs. If secrets
 *     lived on that document, every one of those call sites would be one
 *     forgotten `.select()` away from leaking every tenant's live
 *     credentials at once. Here, the secret material is in a collection
 *     nothing queries casually.
 *   - the envelope columns additionally carry `select: false`, so even a
 *     direct `OrganizationCredential.find()` returns the *metadata* (which
 *     organization has which provider configured, and when it was last
 *     rotated) without the ciphertext. Reading the secret requires an
 *     explicit `.select("+ciphertext +iv +authTag")`, which only
 *     `organization-credentials.service.ts` does.
 *   - `toJSON` deletes the envelope outright, so a row that reaches a DTO
 *     or a log line by accident carries nothing sensitive.
 *
 * The stored value is an AES-256-GCM envelope produced by
 * `@/lib/crypto/secret-box`, authenticated against
 * (organizationId, provider, field). Moving a row between organizations or
 * between fields therefore fails to open rather than silently decrypting —
 * see the tests in `secret-box.test.ts` for why that matters when the
 * thing being protected is a merchant account.
 *
 * Rotation: `keyVersion` records which master key sealed the row, so the
 * deployment key can be rotated forward while old rows still open.
 */

/** Credential owners. Values are lowercase to read naturally in the AAD. */
export const CredentialProvider = {
  STRIPE: "stripe",
  PAYPAL: "paypal",
  SMTP: "smtp",
} as const;
export type CredentialProvider =
  (typeof CredentialProvider)[keyof typeof CredentialProvider];
const CREDENTIAL_PROVIDERS = Object.values(CredentialProvider);

/**
 * Which secret within a provider. Kept as a free-form (but length-capped)
 * string rather than an enum so adding a provider that needs a third secret
 * doesn't require a schema migration; the AAD binding means a wrong value
 * simply fails to open.
 */
export const CredentialField = {
  SECRET_KEY: "secretKey",
  WEBHOOK_SECRET: "webhookSecret",
  CLIENT_SECRET: "clientSecret",
  PASSWORD: "password",
} as const;
export type CredentialField =
  (typeof CredentialField)[keyof typeof CredentialField];

export interface OrganizationCredentialDoc {
  organizationId: Types.ObjectId;
  provider: CredentialProvider;
  field: string;
  /** Which master key version sealed this row. */
  keyVersion: number;
  /** base64, 12 bytes. `select: false`. */
  iv: string;
  /** base64. `select: false`. */
  ciphertext: string;
  /** base64, 16 bytes. `select: false`. */
  authTag: string;
  /** Last four characters of the plaintext, for operator confirmation in
   *  admin UIs ("…is this the key ending 4f2a?"). Never enough to
   *  reconstruct the secret. */
  hint: string;
  lastRotatedAt?: Date | null;
  createdBy?: Types.ObjectId | null;
  updatedBy?: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

export type OrganizationCredentialDocument =
  HydratedDocument<OrganizationCredentialDoc>;

const organizationCredentialSchema = new Schema<OrganizationCredentialDoc>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },
    provider: {
      type: String,
      enum: CREDENTIAL_PROVIDERS,
      required: true,
    },
    field: { type: String, required: true, trim: true, maxlength: 64 },
    keyVersion: { type: Number, required: true, min: 1, default: 1 },
    iv: { type: String, required: true, maxlength: 32, select: false },
    ciphertext: {
      type: String,
      required: true,
      maxlength: 8192,
      select: false,
    },
    authTag: { type: String, required: true, maxlength: 32, select: false },
    hint: { type: String, default: "", maxlength: 8 },
    lastRotatedAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "organization_credentials",
    toJSON: {
      transform(_doc, ret) {
        const r = ret as Record<string, unknown>;
        r.id = String(r._id);
        delete r._id;
        // Belt and braces: `select: false` keeps these out of ordinary
        // reads, but an explicitly-selected document must not be able to
        // serialise its own secret into a response or a log line.
        delete r.iv;
        delete r.ciphertext;
        delete r.authTag;
        return r;
      },
    },
  },
);

// One row per (organization, provider, field). Also the lookup index the
// credential service uses on every resolve.
organizationCredentialSchema.index(
  { organizationId: 1, provider: 1, field: 1 },
  { unique: true },
);

import { registerModel } from "./register";
export const OrganizationCredential: Model<OrganizationCredentialDoc> =
  registerModel<OrganizationCredentialDoc>(
    "OrganizationCredential",
    organizationCredentialSchema,
  );
