import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Authenticated envelope encryption for organization credentials.
 *
 * Organization *configuration* (brand name, sender address, which gateway)
 * is ordinary data and lives in plain fields on the organization document.
 * Organization *secrets* (a Stripe secret key, a PayPal client secret, an
 * SMTP password) must never sit in plaintext next to it — a stray
 * `Organization.find()` in a debug endpoint, a log line, a Mongo backup, or
 * an aggregation pipeline would leak every tenant's live credentials at
 * once. This module is the boundary those values cross.
 *
 * Algorithm: AES-256-GCM.
 *   - GCM is authenticated, so tampering with stored ciphertext is detected
 *     on open rather than silently yielding garbage that we then hand to a
 *     payment SDK.
 *   - The IV is 96 bits, the size GCM is specified for, and is randomly
 *     generated per seal. Never reuse an (key, iv) pair — with GCM that
 *     leaks the XOR of the plaintexts and, worse, the authentication
 *     subkey. Because we always randomise, callers cannot get this wrong.
 *
 * Associated data (AAD) is the part worth reading twice. Every sealed value
 * is bound to *where it lives* — organization id, provider, and field name.
 * The AAD is not encrypted, it is authenticated: if a row is copied from one
 * organization's document into another's, or a `stripe.secretKey` blob is
 * moved into the `smtp.password` slot, the tag check fails and `open()`
 * throws. Encryption alone would not catch that; a cross-tenant ciphertext
 * swap would decrypt perfectly and quietly bill the wrong merchant.
 *
 * `keyVersion` travels with the ciphertext so the master key can be rotated
 * without a stop-the-world re-encrypt: new writes seal under vN+1 while old
 * rows still open under vN, and a background pass can re-seal at leisure.
 *
 * This module is deliberately pure — it takes the key as an argument and
 * reads no environment. Key resolution is the credential service's job,
 * which keeps this file trivially testable with a fixed key.
 */

/** AES-256 needs exactly 32 bytes of key material. */
export const MASTER_KEY_BYTES = 32;

/** 96-bit nonce — the size AES-GCM is specified for. */
const IV_BYTES = 12;

const ALGORITHM = "aes-256-gcm";

/**
 * A sealed secret, in the shape it is persisted. Every field is base64 so
 * the whole envelope survives BSON, JSON, and a copy-paste into a support
 * ticket without transcoding damage.
 */
export interface SealedSecret {
  /** Which master key version sealed this. See rotation note above. */
  keyVersion: number;
  /** base64, 12 bytes. Random per seal, never reused. */
  iv: string;
  /** base64. */
  ciphertext: string;
  /** base64, 16 bytes. GCM authentication tag. */
  authTag: string;
}

/**
 * Identifies where a secret lives. Authenticated (not encrypted) so a
 * ciphertext cannot be relocated to a different organization, provider, or
 * field without failing the tag check.
 */
export interface SecretScope {
  organizationId: string;
  /** e.g. "stripe" | "paypal" | "smtp" */
  provider: string;
  /** e.g. "secretKey" | "webhookSecret" | "password" */
  field: string;
}

/**
 * Canonical AAD bytes for a scope. Uses NUL as the separator so a value
 * containing the separator can't be crafted to collide with a different
 * scope (NUL cannot appear in any of the three components, all of which are
 * slugs / ObjectId hex / identifiers).
 */
function aadFor(scope: SecretScope): Buffer {
  return Buffer.from(
    `v1\0${scope.organizationId}\0${scope.provider}\0${scope.field}`,
    "utf8",
  );
}

/**
 * Validate and decode a master key supplied as a base64 or hex string.
 *
 * Throws rather than padding, truncating, or hashing a wrong-sized input —
 * silently accepting a short key would produce a system that looks encrypted
 * but isn't. Generate one with:
 *
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 */
export function parseMasterKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Master key is empty");
  }

  // Hex first: a 64-char hex string is also valid base64url-ish input, and
  // interpreting it as base64 would silently yield 48 wrong bytes.
  const key = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed, "base64");

  if (key.length !== MASTER_KEY_BYTES) {
    throw new Error(
      `Master key must decode to exactly ${MASTER_KEY_BYTES} bytes (got ${key.length}). ` +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }
  return key;
}

/** Encrypt `plaintext`, binding the result to `scope`. */
export function seal(
  plaintext: string,
  key: Buffer,
  scope: SecretScope,
  keyVersion: number,
): SealedSecret {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(aadFor(scope));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return {
    keyVersion,
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

/**
 * Decrypt a sealed secret. Throws if the key is wrong, the ciphertext was
 * tampered with, or the envelope has been moved to a different scope.
 *
 * The error message is deliberately non-specific: distinguishing "wrong
 * key" from "wrong scope" from "corrupted tag" would hand an attacker with
 * database read access an oracle for narrowing down which of those it is.
 */
export function open(
  sealed: SealedSecret,
  key: Buffer,
  scope: SecretScope,
): string {
  assertKey(key);
  const iv = Buffer.from(sealed.iv, "base64");
  if (iv.length !== IV_BYTES) {
    throw new Error("Unable to open sealed secret");
  }
  const authTag = Buffer.from(sealed.authTag, "base64");
  if (authTag.length !== 16) {
    throw new Error("Unable to open sealed secret");
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAAD(aadFor(scope));
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, "base64")),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  } catch {
    throw new Error("Unable to open sealed secret");
  }
}

/**
 * Constant-time equality for secret material. Used when comparing a
 * caller-supplied value against a decrypted one (e.g. verifying an
 * unrotated webhook secret) so the comparison itself doesn't leak the
 * matching prefix length through timing.
 */
export function secretEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  // timingSafeEqual throws on length mismatch, which is itself a (benign)
  // length disclosure — unavoidable, and length is not the secret.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function assertKey(key: Buffer): void {
  if (key.length !== MASTER_KEY_BYTES) {
    throw new Error(
      `Master key must be exactly ${MASTER_KEY_BYTES} bytes (got ${key.length})`,
    );
  }
}
