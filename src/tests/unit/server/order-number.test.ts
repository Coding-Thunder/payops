import { describe, expect, it } from "vitest";

import { generateOrderNumber } from "@/server/services/order-number";

describe("generateOrderNumber", () => {
  it("uses the provided prefix and embeds today's UTC date", () => {
    const out = generateOrderNumber("ABC");
    const d = new Date();
    const yy = String(d.getUTCFullYear()).slice(-2);
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    // Suffix bumped to 10 chars (crypto.randomBytes, 50 bits of entropy)
    // so the daily order-number space isn't brute-forceable.
    expect(out).toMatch(new RegExp(`^ABC-${yy}${mm}${dd}-[A-Z2-9]{10}$`));
  });

  it("strips non-alpha characters from the prefix", () => {
    expect(generateOrderNumber("a1b!c2")).toMatch(/^ABC-/);
  });

  it("falls back to ORD when the prefix has no letters", () => {
    expect(generateOrderNumber("123!@#")).toMatch(/^ORD-/);
  });

  it("uppercases mixed-case prefixes", () => {
    expect(generateOrderNumber("rentXY")).toMatch(/^RENTXY-/);
  });

  it("never uses ambiguous characters (I, O, 0, 1) in the suffix", () => {
    for (let i = 0; i < 500; i += 1) {
      const out = generateOrderNumber("ORD");
      const suffix = out.split("-")[2];
      expect(suffix).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/);
    }
  });

  it("produces high entropy across many invocations", () => {
    const set = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      set.add(generateOrderNumber("ORD"));
    }
    // Collisions in 200 draws would be vanishingly unlikely given
    // 32^10 ≈ 1.1×10^15 of suffix space + crypto-grade RNG.
    expect(set.size).toBe(200);
  });
});
