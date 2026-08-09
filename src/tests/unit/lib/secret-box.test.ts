import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  MASTER_KEY_BYTES,
  open,
  parseMasterKey,
  seal,
  secretEquals,
  type SecretScope,
} from "@/lib/crypto/secret-box";

/**
 * Envelope encryption for organization credentials.
 *
 * The properties pinned here are the ones a multi-tenant payment system
 * cannot afford to get wrong:
 *
 *   - a secret sealed for one organization must not open for another, even
 *     with the correct master key (cross-tenant ciphertext relocation)
 *   - a secret sealed for one field must not open in another field's slot
 *   - any bit-flip in the stored envelope must fail loudly, not decrypt to
 *     garbage that we then hand to a payment SDK
 *   - two seals of the same plaintext must differ (no IV reuse)
 */

const KEY = randomBytes(MASTER_KEY_BYTES);

const SCOPE: SecretScope = {
  organizationId: "org_rentalconfirmation",
  provider: "stripe",
  field: "secretKey",
};

const SECRET = "test-only-not-a-real-stripe-key";

describe("secret-box round trip", () => {
  it("opens what it sealed", () => {
    const sealed = seal(SECRET, KEY, SCOPE, 1);
    expect(open(sealed, KEY, SCOPE)).toBe(SECRET);
  });

  it("never stores the plaintext in the envelope", () => {
    const sealed = seal(SECRET, KEY, SCOPE, 1);
    const serialised = JSON.stringify(sealed);
    expect(serialised).not.toContain(SECRET);
    expect(serialised).not.toContain("not-a-real-stripe");
  });

  it("round-trips the key version so the master key can be rotated", () => {
    const sealed = seal(SECRET, KEY, SCOPE, 7);
    expect(sealed.keyVersion).toBe(7);
    expect(open(sealed, KEY, SCOPE)).toBe(SECRET);
  });

  it("produces a different envelope every time (no IV reuse)", () => {
    const a = seal(SECRET, KEY, SCOPE, 1);
    const b = seal(SECRET, KEY, SCOPE, 1);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    // ...and both still open.
    expect(open(a, KEY, SCOPE)).toBe(SECRET);
    expect(open(b, KEY, SCOPE)).toBe(SECRET);
  });

  it("handles unicode and empty plaintext", () => {
    for (const value of ["", "pa55·wörd·🔐", "x".repeat(4096)]) {
      const sealed = seal(value, KEY, SCOPE, 1);
      expect(open(sealed, KEY, SCOPE)).toBe(value);
    }
  });
});

describe("secret-box rejects", () => {
  it("a wrong master key", () => {
    const sealed = seal(SECRET, KEY, SCOPE, 1);
    const otherKey = randomBytes(MASTER_KEY_BYTES);
    expect(() => open(sealed, otherKey, SCOPE)).toThrow(/unable to open/i);
  });

  it("a ciphertext relocated to a DIFFERENT organization", () => {
    // The attack this prevents: copy org A's encrypted Stripe key into org
    // B's document. Without AAD binding this decrypts perfectly and org B
    // silently charges through org A's merchant account.
    const sealed = seal(SECRET, KEY, SCOPE, 1);
    const otherOrg: SecretScope = {
      ...SCOPE,
      organizationId: "org_tripreservations",
    };
    expect(() => open(sealed, KEY, otherOrg)).toThrow(/unable to open/i);
  });

  it("a ciphertext relocated to a different provider or field", () => {
    const sealed = seal(SECRET, KEY, SCOPE, 1);
    expect(() =>
      open(sealed, KEY, { ...SCOPE, provider: "paypal" }),
    ).toThrow(/unable to open/i);
    expect(() =>
      open(sealed, KEY, { ...SCOPE, field: "webhookSecret" }),
    ).toThrow(/unable to open/i);
  });

  it("a tampered ciphertext", () => {
    const sealed = seal(SECRET, KEY, SCOPE, 1);
    const raw = Buffer.from(sealed.ciphertext, "base64");
    raw[0] ^= 0xff;
    expect(() =>
      open({ ...sealed, ciphertext: raw.toString("base64") }, KEY, SCOPE),
    ).toThrow(/unable to open/i);
  });

  it("a tampered authentication tag", () => {
    const sealed = seal(SECRET, KEY, SCOPE, 1);
    const tag = Buffer.from(sealed.authTag, "base64");
    tag[0] ^= 0xff;
    expect(() =>
      open({ ...sealed, authTag: tag.toString("base64") }, KEY, SCOPE),
    ).toThrow(/unable to open/i);
  });

  it("a tampered or truncated IV", () => {
    const sealed = seal(SECRET, KEY, SCOPE, 1);
    const iv = Buffer.from(sealed.iv, "base64");
    iv[0] ^= 0xff;
    expect(() =>
      open({ ...sealed, iv: iv.toString("base64") }, KEY, SCOPE),
    ).toThrow(/unable to open/i);
    expect(() =>
      open({ ...sealed, iv: Buffer.alloc(4).toString("base64") }, KEY, SCOPE),
    ).toThrow(/unable to open/i);
  });

  it("gives the same opaque error for every failure mode", () => {
    // No oracle: an attacker with DB read access must not be able to tell
    // "wrong key" from "wrong org" from "corrupt tag".
    const sealed = seal(SECRET, KEY, SCOPE, 1);
    const messages = new Set<string>();
    const collect = (fn: () => unknown) => {
      try {
        fn();
      } catch (err) {
        messages.add(err instanceof Error ? err.message : String(err));
      }
    };
    collect(() => open(sealed, randomBytes(MASTER_KEY_BYTES), SCOPE));
    collect(() => open(sealed, KEY, { ...SCOPE, organizationId: "other" }));
    collect(() => open({ ...sealed, authTag: Buffer.alloc(16).toString("base64") }, KEY, SCOPE));
    expect(messages.size).toBe(1);
  });
});

describe("parseMasterKey", () => {
  it("accepts 32 bytes as base64 or hex", () => {
    const raw = randomBytes(MASTER_KEY_BYTES);
    expect(parseMasterKey(raw.toString("base64"))).toEqual(raw);
    expect(parseMasterKey(raw.toString("hex"))).toEqual(raw);
    expect(parseMasterKey(`  ${raw.toString("base64")}  `)).toEqual(raw);
  });

  it("refuses a short key rather than padding it", () => {
    expect(() => parseMasterKey(randomBytes(16).toString("base64"))).toThrow(
      /exactly 32 bytes/i,
    );
  });

  it("refuses an empty key", () => {
    expect(() => parseMasterKey("   ")).toThrow(/empty/i);
  });
});

describe("secretEquals", () => {
  it("compares by value", () => {
    expect(secretEquals("whsec_abc", "whsec_abc")).toBe(true);
    expect(secretEquals("whsec_abc", "whsec_abd")).toBe(false);
  });

  it("returns false on a length mismatch instead of throwing", () => {
    expect(secretEquals("short", "considerably-longer")).toBe(false);
  });
});
