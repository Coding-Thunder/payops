// @vitest-environment node

import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetMasterKeyForTesting,
  decryptSecret,
  encryptSecret,
  isEncryptionAvailable,
  type EncryptedSecret,
} from "@/lib/crypto/envelope";

/**
 * AES-256-GCM envelope: round-trip + tamper-detection + key-rotation
 * preconditions.
 *
 * We mutate `process.env.TRACETXN_MASTER_KEY` per test and bust the
 * envelope module's master-key cache via `_resetMasterKeyForTesting`.
 * Without that reset, the cached buffer from a prior test would shadow
 * the new env value.
 */

function freshMasterKey(): string {
  return randomBytes(32).toString("base64");
}

beforeEach(() => {
  _resetMasterKeyForTesting();
});

afterEach(() => {
  delete process.env.TRACETXN_MASTER_KEY;
  _resetMasterKeyForTesting();
});

describe("envelope encryption", () => {
  describe("happy path", () => {
    it("round-trips a UTF-8 secret", () => {
      process.env.TRACETXN_MASTER_KEY = freshMasterKey();
      const plaintext = "sk_test_1234567890";
      const enc = encryptSecret(plaintext);
      expect(decryptSecret(enc)).toBe(plaintext);
    });

    it("round-trips a secret with non-ASCII bytes", () => {
      process.env.TRACETXN_MASTER_KEY = freshMasterKey();
      const plaintext = "whsec_péyops™🔐";
      const enc = encryptSecret(plaintext);
      expect(decryptSecret(enc)).toBe(plaintext);
    });

    it("produces a different IV on every call (no nonce reuse)", () => {
      process.env.TRACETXN_MASTER_KEY = freshMasterKey();
      const a = encryptSecret("same-secret");
      const b = encryptSecret("same-secret");
      expect(a.iv).not.toBe(b.iv);
      expect(a.ciphertext).not.toBe(b.ciphertext);
      expect(a.authTag).not.toBe(b.authTag);
    });
  });

  describe("misconfiguration", () => {
    it("throws when TRACETXN_MASTER_KEY is missing", () => {
      delete process.env.TRACETXN_MASTER_KEY;
      expect(() => encryptSecret("anything")).toThrowError(
        /TRACETXN_MASTER_KEY/i,
      );
    });

    it("throws when TRACETXN_MASTER_KEY is the wrong length", () => {
      // 16 bytes, too short for AES-256.
      process.env.TRACETXN_MASTER_KEY = Buffer.alloc(16).toString("base64");
      expect(() => encryptSecret("anything")).toThrowError(/32 bytes/i);
    });

    it("isEncryptionAvailable() reflects env state", () => {
      delete process.env.TRACETXN_MASTER_KEY;
      expect(isEncryptionAvailable()).toBe(false);
      process.env.TRACETXN_MASTER_KEY = freshMasterKey();
      _resetMasterKeyForTesting();
      expect(isEncryptionAvailable()).toBe(true);
    });
  });

  describe("tamper detection", () => {
    function withFreshKey(): EncryptedSecret {
      process.env.TRACETXN_MASTER_KEY = freshMasterKey();
      return encryptSecret("sk_live_secret_value");
    }

    it("rejects a flipped bit in ciphertext", () => {
      const enc = withFreshKey();
      const bytes = Buffer.from(enc.ciphertext, "base64");
      bytes[0] = bytes[0] ^ 0xff;
      const tampered: EncryptedSecret = {
        ...enc,
        ciphertext: bytes.toString("base64"),
      };
      expect(() => decryptSecret(tampered)).toThrow();
    });

    it("rejects a flipped bit in the auth tag", () => {
      const enc = withFreshKey();
      const tagBytes = Buffer.from(enc.authTag, "base64");
      tagBytes[0] = tagBytes[0] ^ 0xff;
      const tampered: EncryptedSecret = {
        ...enc,
        authTag: tagBytes.toString("base64"),
      };
      expect(() => decryptSecret(tampered)).toThrow();
    });

    it("rejects a flipped bit in the IV", () => {
      const enc = withFreshKey();
      const ivBytes = Buffer.from(enc.iv, "base64");
      ivBytes[0] = ivBytes[0] ^ 0xff;
      const tampered: EncryptedSecret = { ...enc, iv: ivBytes.toString("base64") };
      expect(() => decryptSecret(tampered)).toThrow();
    });

    it("rejects decryption with a different master key", () => {
      process.env.TRACETXN_MASTER_KEY = freshMasterKey();
      const enc = encryptSecret("sk_live_originalkey");
      // Rotate the env to a different key, old blobs no longer decrypt.
      process.env.TRACETXN_MASTER_KEY = freshMasterKey();
      _resetMasterKeyForTesting();
      expect(() => decryptSecret(enc)).toThrow();
    });
  });

  describe("forwards-compat", () => {
    it("rejects an unknown keyVersion", () => {
      process.env.TRACETXN_MASTER_KEY = freshMasterKey();
      const enc = encryptSecret("hello");
      const future = {
        ...enc,
        keyVersion: "v2" as unknown as "v1",
      };
      expect(() => decryptSecret(future)).toThrowError(/version/i);
    });
  });
});
