import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

/**
 * AES-256-GCM envelope encryption for at-rest secrets.
 *
 * Used by `GatewayCredential` to store Stripe / Razorpay / etc. secret
 * keys + webhook secrets without exposing them in DB dumps, logs, or
 * stack traces. The master key lives in `TRACETXN_MASTER_KEY` (32 bytes,
 * base64-encoded) and is rotated out-of-band, re-encrypt every row
 * with the new key when rotating.
 *
 * Why a flat AES-GCM design and not full envelope-with-data-keys:
 *   - One master key + per-row IV is the simplest design that's still
 *     secure. The "data key" pattern matters when you want per-row
 *     keys backed by a KMS (so a leaked DB dump can't be decrypted
 *     without the KMS itself). At TraceTxn's current scale + ops model,
 *     the master key would live in the same secrets manager the data
 *     key would, no extra blast-radius reduction.
 *   - The `keyVersion` field below leaves the door open: a future
 *     rotation just writes new rows with `keyVersion: 'v2'`, and
 *     `decrypt()` dispatches on the field.
 *
 * Output shape (stored on the model):
 *   {
 *     iv:         base64,  // 12 bytes, GCM nonce
 *     ciphertext: base64,  // length == plaintext length
 *     authTag:    base64,  // 16 bytes, GCM auth tag
 *     keyVersion: 'v1',
 *   }
 *
 * Tamper detection: GCM's auth tag fails decryption on any single-bit
 * flip in iv / ciphertext / authTag, there's no need for a separate
 * HMAC.
 */

export interface EncryptedSecret {
  iv: string;
  ciphertext: string;
  authTag: string;
  keyVersion: "v1";
}

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

let cachedKey: Buffer | null = null;

/**
 * Resolve the master key once per process. Reads from
 * `TRACETXN_MASTER_KEY` (base64). Throws if missing or malformed -
 * callers should let the error propagate so a misconfigured deploy
 * fails loudly instead of silently writing plaintext.
 */
function getMasterKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.TRACETXN_MASTER_KEY;
  if (!raw) {
    throw new Error(
      "TRACETXN_MASTER_KEY is not set, required to encrypt or decrypt gateway credentials. " +
        "Generate one with: openssl rand -base64 32",
    );
  }
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== KEY_BYTES) {
    throw new Error(
      `TRACETXN_MASTER_KEY must decode to exactly ${KEY_BYTES} bytes (got ${buf.length}). ` +
        "Generate a fresh one with: openssl rand -base64 32",
    );
  }
  cachedKey = buf;
  return buf;
}

/** Test-only, clears the cached master key so a test can swap envs. */
export function _resetMasterKeyForTesting(): void {
  cachedKey = null;
}

/**
 * Encrypt a UTF-8 string with the master key. The result is safe to
 * persist verbatim, the auth tag detects any tampering at decrypt
 * time.
 */
export function encryptSecret(plaintext: string): EncryptedSecret {
  if (typeof plaintext !== "string") {
    throw new TypeError("encryptSecret expects a string");
  }
  const key = getMasterKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return {
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    authTag: authTag.toString("base64"),
    keyVersion: "v1",
  };
}

/**
 * Decrypt an `EncryptedSecret` back to UTF-8 plaintext. Throws on:
 *   - missing/wrong-length master key
 *   - unknown `keyVersion`
 *   - any tampering (GCM auth tag mismatch)
 *
 * Caller MUST treat the return value as sensitive, pass it directly
 * into the Stripe (or other gateway) client; never log it.
 */
export function decryptSecret(encrypted: EncryptedSecret): string {
  if (encrypted.keyVersion !== "v1") {
    throw new Error(
      `Unknown TRACETXN_MASTER_KEY version: ${encrypted.keyVersion}`,
    );
  }
  const key = getMasterKey();
  const iv = Buffer.from(encrypted.iv, "base64");
  const ciphertext = Buffer.from(encrypted.ciphertext, "base64");
  const authTag = Buffer.from(encrypted.authTag, "base64");
  if (iv.length !== IV_BYTES) {
    throw new Error("Encrypted secret: invalid IV length");
  }
  if (authTag.length !== AUTH_TAG_BYTES) {
    throw new Error("Encrypted secret: invalid auth tag length");
  }
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

/**
 * True iff the env carries a valid master key. Useful for gating UI
 * affordances ("you must configure TRACETXN_MASTER_KEY before saving
 * gateway credentials") without throwing.
 */
export function isEncryptionAvailable(): boolean {
  try {
    getMasterKey();
    return true;
  } catch {
    return false;
  }
}
