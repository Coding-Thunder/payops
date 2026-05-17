import { describe, expect, it } from "vitest";

import { generateOrderNumber } from "@/server/services/order-number";

describe("generateOrderNumber", () => {
  it("uses the provided prefix and embeds today's UTC date", () => {
    const out = generateOrderNumber("ABC");
    const d = new Date();
    const yy = String(d.getUTCFullYear()).slice(-2);
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    expect(out).toMatch(new RegExp(`^ABC-${yy}${mm}${dd}-[A-Z2-9]{6}$`));
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
      expect(suffix).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    }
  });

  it("produces high entropy across many invocations", () => {
    const set = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      set.add(generateOrderNumber("ORD"));
    }
    // Collisions in 200 draws would be a real concern given 32^6 ≈ 1.07B.
    expect(set.size).toBe(200);
  });
});
