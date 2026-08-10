import "server-only";

import { Types } from "mongoose";

import {
  open,
  parseMasterKey,
  seal,
  type SecretScope,
} from "@/lib/crypto/secret-box";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import {
  CredentialProvider,
  OrganizationCredential,
  type OrganizationCredentialDoc,
} from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";

/**
 * The only module permitted to decrypt organization credentials.
 *
 * Everything outside this file deals in *resolved* values handed to it by a
 * caller, never in ciphertext and never in the master key. Keeping the
 * decrypt path to one file is what makes "where can a secret escape?" an
 * answerable question.
 *
 * Design rules enforced here:
 *
 *   1. Fail at point of use, never at boot. `CREDENTIALS_MASTER_KEY` is
 *      optional in the env schema; if it is missing, `getSecret` returns
 *      null and callers fall back to their deployment-level configuration.
 *      That is what lets this land in production before any key is
 *      provisioned, with RentalConfirmation continuing on env values.
 *   2. Never log secret material. Failures log the organization, provider,
 *      and field — never the plaintext, the ciphertext, or the key.
 *   3. Never return the envelope. Callers get a string or null.
 *   4. Values are bound to their scope by the AAD in `secret-box`, so a row
 *      relocated between organizations or fields fails to open.
 */

/** Cached decode of the master key — parsing is cheap but this runs on
 *  every payment and every email send. Keyed by the raw string so a
 *  rotated env value invalidates it naturally. */
let cachedKey: { raw: string; key: Buffer } | null = null;

function resolveMasterKey(): Buffer | null {
  const raw = env.server.CREDENTIALS_MASTER_KEY?.trim();
  if (!raw) return null;
  if (cachedKey && cachedKey.raw === raw) return cachedKey.key;
  const key = parseMasterKey(raw);
  cachedKey = { raw, key };
  return key;
}

/** True when a master key is configured and the vault can be used at all. */
export function isVaultConfigured(): boolean {
  try {
    return resolveMasterKey() !== null;
  } catch (err) {
    // A malformed key is a configuration error worth shouting about, but it
    // must not take the process down — callers fall back to env values.
    logger.error("credentials.master_key_invalid", {
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export interface CredentialRef {
  organizationId: string;
  provider: CredentialProvider;
  field: string;
}

function scopeOf(ref: CredentialRef): SecretScope {
  return {
    organizationId: ref.organizationId,
    provider: ref.provider,
    field: ref.field,
  };
}

/**
 * Read and decrypt one credential.
 *
 * Returns null — rather than throwing — when the vault is unconfigured or
 * the organization simply has no such credential stored. Both are ordinary
 * states during the migration: an organization that has not had its keys
 * moved into the vault yet must keep working on deployment-level
 * configuration. A row that exists but cannot be opened IS an error and is
 * logged loudly, because that means a wrong master key, a corrupted row, or
 * a ciphertext that has been moved between organizations.
 */
export async function getSecret(ref: CredentialRef): Promise<string | null> {
  // A malformed CREDENTIALS_MASTER_KEY must not take down every payment on
  // the deployment. `resolveMasterKey` throws on a key that is not 32 bytes,
  // and this is called on the payment-link hot path — so a fat-fingered
  // rotation would otherwise turn "the vault is misconfigured" into "nobody
  // can generate a payment link", including the default organization, which
  // does not even use the vault yet. Log loudly, degrade to "no stored
  // credential", and let the caller's own rules decide: the default
  // organization falls back to env, everyone else is refused.
  let key: Buffer | null;
  try {
    key = resolveMasterKey();
  } catch (err) {
    logger.error("credentials.master_key_invalid", {
      organizationId: ref.organizationId,
      provider: ref.provider,
      field: ref.field,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  if (!key) return null;
  if (!Types.ObjectId.isValid(ref.organizationId)) return null;

  await connectMongo();
  const row = await OrganizationCredential.findOne({
    organizationId: new Types.ObjectId(ref.organizationId),
    provider: ref.provider,
    field: ref.field,
  })
    // The envelope columns are `select: false`; this is the one place that
    // asks for them back.
    .select("+iv +ciphertext +authTag")
    .lean<Pick<
      OrganizationCredentialDoc,
      "iv" | "ciphertext" | "authTag" | "keyVersion"
    > | null>();

  if (!row) return null;

  try {
    return open(
      {
        keyVersion: row.keyVersion,
        iv: row.iv,
        ciphertext: row.ciphertext,
        authTag: row.authTag,
      },
      key,
      scopeOf(ref),
    );
  } catch (err) {
    logger.error("credentials.open_failed", {
      organizationId: ref.organizationId,
      provider: ref.provider,
      field: ref.field,
      keyVersion: row.keyVersion,
      err: err instanceof Error ? err.message : String(err),
    });
    throw new Error(
      `Stored credential ${ref.provider}.${ref.field} could not be opened`,
    );
  }
}

export interface PutSecretInput extends CredentialRef {
  value: string;
  actorId?: string | null;
}

/**
 * Store or rotate one credential. Idempotent by (organization, provider,
 * field) — writing again replaces the envelope and stamps `lastRotatedAt`.
 */
export async function putSecret(input: PutSecretInput): Promise<void> {
  const key = resolveMasterKey();
  if (!key) {
    throw new Error(
      "Credential vault is not configured — set CREDENTIALS_MASTER_KEY",
    );
  }
  if (!input.value) {
    throw new Error("Refusing to store an empty credential");
  }
  if (!Types.ObjectId.isValid(input.organizationId)) {
    throw new Error("Invalid organizationId");
  }

  await connectMongo();
  const sealed = seal(
    input.value,
    key,
    scopeOf(input),
    env.server.CREDENTIALS_KEY_VERSION,
  );
  const actor = input.actorId && Types.ObjectId.isValid(input.actorId)
    ? new Types.ObjectId(input.actorId)
    : null;

  const existing = await OrganizationCredential.findOne({
    organizationId: new Types.ObjectId(input.organizationId),
    provider: input.provider,
    field: input.field,
  })
    .select("_id")
    .lean<{ _id: Types.ObjectId } | null>();

  await OrganizationCredential.updateOne(
    {
      organizationId: new Types.ObjectId(input.organizationId),
      provider: input.provider,
      field: input.field,
    },
    {
      $set: {
        keyVersion: sealed.keyVersion,
        iv: sealed.iv,
        ciphertext: sealed.ciphertext,
        authTag: sealed.authTag,
        // Enough for an operator to confirm which key they pasted, far too
        // little to reconstruct it.
        hint: input.value.slice(-4),
        updatedBy: actor,
        ...(existing ? { lastRotatedAt: new Date() } : {}),
      },
      $setOnInsert: { createdBy: actor },
    },
    { upsert: true },
  );

  logger.info("credentials.stored", {
    organizationId: input.organizationId,
    provider: input.provider,
    field: input.field,
    keyVersion: sealed.keyVersion,
    rotated: Boolean(existing),
  });
}

/**
 * Which credentials an organization has configured. Metadata only — the
 * envelope columns are `select: false`, so this cannot leak secrets even by
 * accident.
 */
export async function listCredentialMetadata(
  organizationId: string,
): Promise<
  Array<{
    provider: CredentialProvider;
    field: string;
    hint: string;
    keyVersion: number;
    lastRotatedAt: Date | null;
    updatedAt: Date;
  }>
> {
  if (!Types.ObjectId.isValid(organizationId)) return [];
  await connectMongo();
  const rows = await OrganizationCredential.find({
    organizationId: new Types.ObjectId(organizationId),
  })
    .sort({ provider: 1, field: 1 })
    .lean<
      Array<
        Pick<
          OrganizationCredentialDoc,
          | "provider"
          | "field"
          | "hint"
          | "keyVersion"
          | "lastRotatedAt"
          | "updatedAt"
        >
      >
    >();

  return rows.map((r) => ({
    provider: r.provider,
    field: r.field,
    hint: r.hint,
    keyVersion: r.keyVersion,
    lastRotatedAt: r.lastRotatedAt ?? null,
    updatedAt: r.updatedAt,
  }));
}

/** Remove one credential. The organization falls back to deployment-level
 *  configuration on its next resolve. */
export async function deleteSecret(ref: CredentialRef): Promise<boolean> {
  if (!Types.ObjectId.isValid(ref.organizationId)) return false;
  await connectMongo();
  const res = await OrganizationCredential.deleteOne({
    organizationId: new Types.ObjectId(ref.organizationId),
    provider: ref.provider,
    field: ref.field,
  });
  return res.deletedCount > 0;
}

/** Test-only: drop the memoised master key so a test can swap the env. */
export function _resetCredentialCacheForTests(): void {
  cachedKey = null;
}
