import "server-only";

import { Types } from "mongoose";

import {
  AuditAction,
  AuditEntity,
  PaymentGatewayKey,
  type UserRole,
} from "@/lib/constants/enums";
import {
  decryptSecret,
  encryptSecret,
  isEncryptionAvailable,
} from "@/lib/crypto/envelope";
import { env } from "@/lib/env";
import { ConflictError, ValidationError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import {
  GatewayCredential,
  GatewayMode,
  type GatewayCredentialDoc,
} from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import { isLegacyTenant } from "@/server/db/org/legacy";
import { orgIdFilter, requireOrgId } from "@/server/db/org/org-context";

import type { RequestContext } from "@/server/api/request-context";
import { recordAudit } from "@/server/services/audit.service";

import {
  buildStripeWebhookCallbackUrl,
  deleteStripeWebhookEndpoint,
  registerStripeWebhookEndpoint,
  verifyStripeSecret,
} from "./stripe-onboarding";

/**
 * Per-org gateway credential resolution.
 *
 * `loadGatewayCredential(orgId, gateway)` is the single source of truth
 * for "what API keys do we use to talk to this gateway on behalf of
 * this org". It returns DECRYPTED credentials — caller MUST treat them
 * as sensitive (pass directly into the gateway SDK; never log).
 *
 * Legacy tenant: when no row exists and the gateway is STRIPE, we fall
 * back to `process.env.STRIPE_*` so the existing single-tenant build
 * keeps working without any data migration. The fallback is intentional
 * and explicit (not an oversight): tenant #1's credentials live in env;
 * tenant #2+ live in Mongo.
 *
 * Once every tenant has a `GatewayCredential` row, the env fallback can
 * be retired in a Phase-3b pass.
 */

export interface ResolvedCredential {
  orgId: string | null;
  gateway: PaymentGatewayKey;
  mode: GatewayMode;
  enabled: boolean;
  /** PLAINTEXT. Caller must not log or persist. */
  secretKey: string;
  /** PLAINTEXT. Caller must not log or persist. */
  webhookSecret: string;
  publishableKey: string | null;
  accountId: string | null;
  /** True iff the resolved values came from `process.env` (legacy
   *  fallback) rather than a `GatewayCredential` row. Useful so the
   *  admin UI can show a "configure your own credentials" prompt. */
  source: "env" | "org";
}

/**
 * Load the credentials a service should use to talk to `gateway` on
 * behalf of `orgId`. Returns null only when:
 *   - the gateway is not Stripe (no env fallback for non-Stripe yet)
 *     AND no per-org row exists, OR
 *   - the row exists but `enabled: false`.
 *
 * Throws on decrypt failure (master key missing/wrong, tampered blob).
 */
export async function loadGatewayCredential(
  orgId: string | null,
  gateway: PaymentGatewayKey,
): Promise<ResolvedCredential | null> {
  await connectMongo();

  // Per-org lookup — only when caller passed an org.
  if (orgId) {
    requireOrgId(orgId);
    const doc = await GatewayCredential.findOne({
      orgId: orgIdFilter(orgId),
      gateway,
    }).lean<GatewayCredentialDoc & { _id: unknown }>();
    if (doc) {
      if (!doc.enabled) return null;
      return {
        orgId,
        gateway: doc.gateway,
        mode: doc.mode,
        enabled: doc.enabled,
        secretKey: decryptSecret(doc.secretKey),
        webhookSecret: decryptSecret(doc.webhookSecret),
        publishableKey: doc.publishableKey ?? null,
        accountId: doc.accountId ?? null,
        source: "org",
      };
    }
    // Per-org row missing — env-fallback eligibility is decided below.
    // Phase-4b SECURITY GATE: only the legacy tenant gets to use env
    // credentials. Any other tenant without their own row fails closed
    // so we never silently route Tenant #2's money to the platform's
    // Stripe account.
    if (!(await isLegacyTenant(orgId))) {
      return null;
    }
  }

  // Env-fallback path. Reserved for the LEGACY tenant only — see the
  // SECURITY GATE above. Reached when:
  //   - orgId is null/undefined (un-migrated legacy callers), OR
  //   - orgId points at the legacy organization and has no per-org row.
  // Any other tenant short-circuited above.
  if (gateway !== PaymentGatewayKey.STRIPE) return null;
  const secretKey = env.server.STRIPE_SECRET_KEY;
  const webhookSecret = env.server.STRIPE_WEBHOOK_SECRET;
  if (!secretKey || !webhookSecret) return null;
  return {
    orgId: orgId ?? null,
    gateway,
    mode: secretKey.startsWith("sk_live_") ? GatewayMode.LIVE : GatewayMode.TEST,
    enabled: true,
    secretKey,
    webhookSecret,
    publishableKey: env.public.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? null,
    accountId: null,
    source: "env",
  };
}

/* ─────────────────────────── Writes (admin) ─────────────────────────── */

export interface SaveCredentialInput {
  gateway: PaymentGatewayKey;
  mode: GatewayMode;
  secretKey: string;
  webhookSecret: string;
  publishableKey?: string | null;
  accountId?: string | null;
}

interface SaveContext {
  actor: { id: string; name: string; role: UserRole };
  orgId: string;
  request: RequestContext | null;
}

export interface SavedCredentialDTO {
  orgId: string;
  gateway: PaymentGatewayKey;
  mode: GatewayMode;
  enabled: boolean;
  publishableKey: string | null;
  accountId: string | null;
  /** Last 4 of the secret key — useful for "did I paste the right one"
   *  confirmation in the admin UI without re-exposing the secret. */
  secretKeyLast4: string;
  configuredAt: string;
  updatedAt: string;
}

function buildDTO(doc: GatewayCredentialDoc, secretKeyPlaintext: string): SavedCredentialDTO {
  return {
    orgId: String(doc.orgId),
    gateway: doc.gateway,
    mode: doc.mode,
    enabled: doc.enabled,
    publishableKey: doc.publishableKey ?? null,
    accountId: doc.accountId ?? null,
    secretKeyLast4: secretKeyPlaintext.slice(-4),
    configuredAt: doc.configuredAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

/**
 * Upsert a per-org credential. Encrypts secret material with
 * `PAYOPS_MASTER_KEY` before writing. Re-saving for the same
 * (orgId, gateway) replaces the encrypted blobs (key rotation).
 *
 * Refuses to write when `PAYOPS_MASTER_KEY` is missing — fail loudly
 * so an operator never persists "encrypted" data they can't decrypt.
 */
export async function saveGatewayCredential(
  input: SaveCredentialInput,
  ctx: SaveContext,
): Promise<SavedCredentialDTO> {
  if (!isEncryptionAvailable()) {
    throw new ConflictError(
      "PAYOPS_MASTER_KEY is not configured. Generate a key (openssl rand -base64 32) and set it before saving gateway credentials.",
    );
  }
  if (!input.secretKey || input.secretKey.length < 8) {
    throw new ValidationError("Secret key looks invalid");
  }
  if (!input.webhookSecret || input.webhookSecret.length < 8) {
    throw new ValidationError("Webhook secret looks invalid");
  }
  requireOrgId(ctx.orgId);
  await connectMongo();

  const encryptedSecret = encryptSecret(input.secretKey);
  const encryptedWebhook = encryptSecret(input.webhookSecret);

  const updated = await GatewayCredential.findOneAndUpdate(
    { orgId: orgIdFilter(ctx.orgId), gateway: input.gateway },
    {
      $set: {
        orgId: orgIdFilter(ctx.orgId),
        gateway: input.gateway,
        mode: input.mode,
        enabled: true,
        secretKey: encryptedSecret,
        webhookSecret: encryptedWebhook,
        publishableKey: input.publishableKey ?? null,
        accountId: input.accountId ?? null,
        configuredBy: new Types.ObjectId(ctx.actor.id),
        configuredAt: new Date(),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean<GatewayCredentialDoc>();
  if (!updated) throw new Error("Failed to save gateway credential");

  await recordAudit({
    action: AuditAction.SETTINGS_UPDATED,
    entityType: AuditEntity.SETTINGS,
    entityId: `gateway:${input.gateway}`,
    orgId: ctx.orgId,
    actor: {
      userId: ctx.actor.id,
      name: ctx.actor.name,
      role: ctx.actor.role,
    },
    request: ctx.request,
    metadata: {
      gateway: input.gateway,
      mode: input.mode,
      secretKeyLast4: input.secretKey.slice(-4),
      action: "gateway_credential_saved",
    },
  });

  return buildDTO(updated, input.secretKey);
}

export async function disableGatewayCredential(
  gateway: PaymentGatewayKey,
  ctx: SaveContext,
): Promise<void> {
  requireOrgId(ctx.orgId);
  await connectMongo();
  // Pass 6a: when PayOps auto-registered a Stripe webhook endpoint
  // during connect, try to delete it on Stripe's side too so we don't
  // leave dangling endpoints. Best-effort: any failure leaves the
  // local row disabled and surfaces a warning log for the operator.
  if (gateway === PaymentGatewayKey.STRIPE) {
    const existing = await GatewayCredential.findOne({
      orgId: orgIdFilter(ctx.orgId),
      gateway,
    }).lean<GatewayCredentialDoc>();
    if (existing?.stripeWebhookEndpointId && existing?.secretKey) {
      try {
        const secretKey = decryptSecret(existing.secretKey);
        await deleteStripeWebhookEndpoint({
          secretKey,
          endpointId: existing.stripeWebhookEndpointId,
        });
      } catch (err) {
        logger.warn("gateway.disable.webhook_delete_failed", {
          orgId: ctx.orgId,
          endpointId: existing.stripeWebhookEndpointId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  await GatewayCredential.updateOne(
    { orgId: orgIdFilter(ctx.orgId), gateway },
    { $set: { enabled: false, stripeWebhookEndpointId: null } },
  );
  await recordAudit({
    action: AuditAction.SETTINGS_UPDATED,
    entityType: AuditEntity.SETTINGS,
    entityId: `gateway:${gateway}`,
    orgId: ctx.orgId,
    actor: {
      userId: ctx.actor.id,
      name: ctx.actor.name,
      role: ctx.actor.role,
    },
    request: ctx.request,
    metadata: { gateway, action: "gateway_credential_disabled" },
  });
}

/* ───────────────────── Pass 6a — Stripe auto-connect ──────────────────── */

export interface ConnectStripeInput {
  mode: GatewayMode;
  secretKey: string;
  publishableKey?: string | null;
  accountId?: string | null;
}

export interface ConnectStripeResult {
  credential: SavedCredentialDTO;
  /** Stripe `we_...` id PayOps registered for this org. Surfaced back
   *  to the admin UI so it can show "we configured a webhook
   *  endpoint" confirmation. */
  webhookEndpointId: string;
  webhookEndpointUrl: string;
}

/**
 * One-shot Stripe connect: takes ONLY the secret key, then
 *   1. Verifies the key with Stripe (`/v1/balance`).
 *   2. Refuses if the key's mode doesn't match what the operator
 *      selected (prevents accidentally putting a LIVE key into TEST
 *      mode or vice versa).
 *   3. Registers PayOps as a webhook endpoint on the operator's
 *      Stripe account; captures the signing secret on the create
 *      response (Stripe only returns it once).
 *   4. Encrypts secret + signing secret with the master key.
 *   5. Upserts the GatewayCredential row.
 *
 * Replaces the manual paste-secret-and-webhook flow for new tenants.
 * The old `saveGatewayCredential` stays around for callers (CLI /
 * tests) that want to bypass Stripe's API.
 */
export async function connectStripeCredential(
  input: ConnectStripeInput,
  ctx: SaveContext,
): Promise<ConnectStripeResult> {
  if (!isEncryptionAvailable()) {
    throw new ConflictError(
      "PAYOPS_MASTER_KEY is not configured. Generate a key (openssl rand -base64 32) and set it before saving gateway credentials.",
    );
  }
  if (!input.secretKey || input.secretKey.length < 10) {
    throw new ValidationError("Secret key looks invalid");
  }
  requireOrgId(ctx.orgId);
  await connectMongo();

  // Step 1: verify with Stripe + mode check.
  const verification = await verifyStripeSecret(input.secretKey, input.mode);
  if (!verification.ok) {
    throw new ValidationError(verification.message);
  }

  // Step 2: register webhook endpoint on operator's Stripe account.
  const callbackUrl = buildStripeWebhookCallbackUrl(
    env.server.APP_URL,
    ctx.orgId,
  );
  const registered = await registerStripeWebhookEndpoint({
    secretKey: input.secretKey,
    callbackUrl,
  });

  // Step 3: encrypt + persist.
  const encryptedSecret = encryptSecret(input.secretKey);
  const encryptedWebhook = encryptSecret(registered.signingSecret);
  const updated = await GatewayCredential.findOneAndUpdate(
    {
      orgId: orgIdFilter(ctx.orgId),
      gateway: PaymentGatewayKey.STRIPE,
    },
    {
      $set: {
        orgId: orgIdFilter(ctx.orgId),
        gateway: PaymentGatewayKey.STRIPE,
        mode: input.mode,
        enabled: true,
        secretKey: encryptedSecret,
        webhookSecret: encryptedWebhook,
        publishableKey: input.publishableKey ?? null,
        accountId: input.accountId ?? verification.accountId,
        stripeWebhookEndpointId: registered.endpointId,
        configuredBy: new Types.ObjectId(ctx.actor.id),
        configuredAt: new Date(),
        lastVerifiedAt: new Date(),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean<GatewayCredentialDoc>();
  if (!updated) throw new Error("Failed to save gateway credential");

  await recordAudit({
    action: AuditAction.SETTINGS_UPDATED,
    entityType: AuditEntity.SETTINGS,
    entityId: `gateway:${PaymentGatewayKey.STRIPE}`,
    orgId: ctx.orgId,
    actor: {
      userId: ctx.actor.id,
      name: ctx.actor.name,
      role: ctx.actor.role,
    },
    request: ctx.request,
    metadata: {
      gateway: PaymentGatewayKey.STRIPE,
      mode: input.mode,
      secretKeyLast4: input.secretKey.slice(-4),
      webhookEndpointId: registered.endpointId,
      action: "gateway_credential_auto_connected",
    },
  });

  return {
    credential: buildDTO(updated, input.secretKey),
    webhookEndpointId: registered.endpointId,
    webhookEndpointUrl: registered.url,
  };
}

/**
 * Lightweight "did the operator paste a key that actually works?"
 * check. Used by the admin UI to give an instant ✓ / ✗ before they
 * commit to save. NEVER persists or encrypts anything — pure
 * read-through to Stripe.
 */
export async function testStripeSecret(
  secretKey: string,
  expectedMode: GatewayMode,
): Promise<
  | { ok: true; livemode: boolean; accountId: string | null }
  | { ok: false; message: string }
> {
  const v = await verifyStripeSecret(secretKey, expectedMode);
  if (v.ok) {
    return { ok: true, livemode: v.livemode, accountId: v.accountId };
  }
  return { ok: false, message: v.message };
}

/* ───────────────────────── Read helpers (admin UI) ─────────────────────── */

/**
 * Lists every per-org credential row (without decrypting anything).
 * Useful for the admin UI to render the "configured gateways" list.
 */
export async function listGatewayCredentialsForOrg(
  orgId: string,
): Promise<SavedCredentialDTO[]> {
  requireOrgId(orgId);
  await connectMongo();
  const docs = await GatewayCredential.find({
    orgId: orgIdFilter(orgId),
  }).lean<GatewayCredentialDoc[]>();
  return docs.map((d) => ({
    orgId: String(d.orgId),
    gateway: d.gateway,
    mode: d.mode,
    enabled: d.enabled,
    publishableKey: d.publishableKey ?? null,
    accountId: d.accountId ?? null,
    // We don't decrypt here — last-4 only available right after a save
    // (see `buildDTO`). Listing shows the mode + enabled state, not
    // the secret fingerprint. Operators rotating need to re-paste.
    secretKeyLast4: "****",
    configuredAt: d.configuredAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  }));
}
