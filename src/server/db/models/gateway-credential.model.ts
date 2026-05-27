import {
  Schema,
  type HydratedDocument,
  type Model,
  type Types,
} from "mongoose";

import {
  PAYMENT_GATEWAY_KEYS,
  PaymentGatewayKey,
} from "@/lib/constants/enums";

import { registerModel } from "./register";

/**
 * Per-org payment-gateway credentials.
 *
 * One row per (orgId, gateway). Secret material (`secretKey`,
 * `webhookSecret`) is AES-256-GCM encrypted at rest using the master
 * key in env — see [src/lib/crypto/envelope.ts]. Public material
 * (`publishableKey`, `accountId`) is stored verbatim so the order /
 * checkout code can build a per-org Stripe client without paying the
 * decrypt cost on the hot path.
 *
 * Lifecycle:
 *   1. Org owner pastes their Stripe keys into /admin/gateways → POST
 *      hits `saveGatewayCredential` → secret material is encrypted +
 *      row is upserted.
 *   2. Order create / regenerate / webhook handlers call
 *      `getGatewayForOrg(orgId, key)` → reads + decrypts on-demand.
 *   3. Operator rotates keys in the Stripe dashboard → operator pastes
 *      new values → new encrypted blob with new IV. No data migration.
 *
 * Legacy tenant: NO row exists. The fallback path in
 * `gateway-credentials.service.loadGatewayCredential` reads
 * `process.env.STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` so the
 * single-tenant build continues working unchanged.
 *
 * Security:
 *   - The encrypted blobs are useless without `PAYOPS_MASTER_KEY`.
 *   - Hard delete is supported — operator off-boarding a tenant
 *     deletes the row + revokes the key in the gateway dashboard.
 *   - `lastVerifiedAt` records the last successful API ping against
 *     the gateway so the admin UI can flag "credentials might be
 *     stale".
 */

export interface EncryptedField {
  iv: string;
  ciphertext: string;
  authTag: string;
  keyVersion: "v1";
}

export const GatewayMode = {
  /** Production keys (`sk_live_…`). Real money. */
  LIVE: "LIVE",
  /** Sandbox keys (`sk_test_…`). Pre-production rehearsal. */
  TEST: "TEST",
} as const;
export type GatewayMode = (typeof GatewayMode)[keyof typeof GatewayMode];
export const GATEWAY_MODES = Object.values(GatewayMode) as GatewayMode[];

export interface GatewayCredentialDoc {
  orgId: Types.ObjectId;
  gateway: PaymentGatewayKey;
  mode: GatewayMode;
  enabled: boolean;

  /** AES-256-GCM encrypted secret key (e.g. Stripe `sk_…`). */
  secretKey: EncryptedField;
  /** AES-256-GCM encrypted webhook signing secret (e.g. Stripe
   *  `whsec_…`). Used by the per-org webhook route to verify
   *  signatures without touching env. */
  webhookSecret: EncryptedField;
  /** Publishable / public key. Safe to ship to the browser; stored
   *  in clear so the order page can pre-render it. */
  publishableKey?: string | null;
  /** Stripe Connect `acct_…` (or equivalent) — reserved for future
   *  marketplace mode. Null today. */
  accountId?: string | null;
  /** Pass 6a — set when PayOps auto-created the Stripe webhook
   *  endpoint on the operator's account. Used to delete the endpoint
   *  when the credential is disabled so we don't leave dangling
   *  endpoints behind. Null for rows where the operator pasted a
   *  webhook secret manually instead of going through the auto-connect
   *  flow. */
  stripeWebhookEndpointId?: string | null;

  configuredBy: Types.ObjectId;
  configuredAt: Date;
  lastVerifiedAt?: Date | null;

  createdAt: Date;
  updatedAt: Date;
}

export type GatewayCredentialDocument =
  HydratedDocument<GatewayCredentialDoc>;

const encryptedFieldSchema = new Schema<EncryptedField>(
  {
    iv: { type: String, required: true, maxlength: 32 },
    // 4096 ≫ longest realistic encrypted secret. Stripe `sk_live_…`
    // tops out around 100 bytes — we cap upstream of any pathological
    // dictionary attack on the model layer.
    ciphertext: { type: String, required: true, maxlength: 4096 },
    authTag: { type: String, required: true, maxlength: 32 },
    keyVersion: {
      type: String,
      required: true,
      enum: ["v1"],
      default: "v1",
    },
  },
  { _id: false },
);

const gatewayCredentialSchema = new Schema<GatewayCredentialDoc>(
  {
    orgId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    gateway: {
      type: String,
      enum: PAYMENT_GATEWAY_KEYS,
      required: true,
    },
    mode: {
      type: String,
      enum: GATEWAY_MODES,
      required: true,
    },
    enabled: { type: Boolean, required: true, default: true, index: true },

    secretKey: { type: encryptedFieldSchema, required: true },
    webhookSecret: { type: encryptedFieldSchema, required: true },
    publishableKey: {
      type: String,
      default: null,
      trim: true,
      maxlength: 200,
    },
    accountId: { type: String, default: null, trim: true, maxlength: 64 },
    stripeWebhookEndpointId: {
      type: String,
      default: null,
      trim: true,
      maxlength: 64,
    },

    configuredBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    configuredAt: { type: Date, required: true, default: Date.now },
    lastVerifiedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "gateway_credentials",
    toJSON: {
      transform(_doc, ret) {
        const r = ret as Record<string, unknown>;
        r.id = String(r._id);
        delete r._id;
        // Never serialise raw encrypted material onto a DTO. The
        // service layer strips these explicitly too — defense in depth.
        delete r.secretKey;
        delete r.webhookSecret;
        return r;
      },
    },
  },
);

// One credential row per (org, gateway). Saving "Stripe" again for the
// same org is an update, not a duplicate.
gatewayCredentialSchema.index(
  { orgId: 1, gateway: 1 },
  { unique: true, name: "gateway_credentials_org_gateway_unique" },
);

export const GatewayCredential: Model<GatewayCredentialDoc> =
  registerModel<GatewayCredentialDoc>(
    "GatewayCredential",
    gatewayCredentialSchema,
  );
