import { describe, expect, it } from "vitest";

import { codesMatch } from "@/server/auth/signup-gate";

/**
 * Core of the private-beta signup gate. `codesMatch` is the pure decision
 * function behind /signup, firebase-session, and /api/auth/signup — a bug
 * here either locks out invited founders or leaves signup wide open, so it
 * carries the gate's whole contract.
 */
describe("codesMatch (signup gate)", () => {
  it("treats an unset expected code as gate-off (accepts anything)", () => {
    expect(codesMatch("whatever", null)).toBe(true);
    expect(codesMatch(undefined, undefined)).toBe(true);
    expect(codesMatch("", "")).toBe(true);
  });

  it("requires an exact match once a code is configured", () => {
    expect(codesMatch("beta-2026", "beta-2026")).toBe(true);
  });

  it("rejects a wrong, empty, missing, or length-mismatched code", () => {
    expect(codesMatch("wrong", "beta-2026")).toBe(false);
    expect(codesMatch("", "beta-2026")).toBe(false);
    expect(codesMatch(undefined, "beta-2026")).toBe(false);
    expect(codesMatch(null, "beta-2026")).toBe(false);
    expect(codesMatch("beta-202", "beta-2026")).toBe(false); // shorter
    expect(codesMatch("beta-2026-extra", "beta-2026")).toBe(false); // longer
  });

  it("is case-sensitive", () => {
    expect(codesMatch("BETA-2026", "beta-2026")).toBe(false);
  });
});
