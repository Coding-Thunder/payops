// @vitest-environment node

import { describe, expect, it } from "vitest";

import { toMinorUnits } from "@/server/services/order.service";

/**
 * Pure helpers exported from the order service. The DB-touching surface
 * lives in the integration suite, these tests run instantly with no
 * Mongo connection.
 */

describe("toMinorUnits", () => {
  it("multiplies USD-like currencies by 100", () => {
    expect(toMinorUnits(1.23, "USD")).toBe(123);
    expect(toMinorUnits(199.5, "EUR")).toBe(19950);
  });

  it("rounds half-cent values to nearest cent", () => {
    expect(toMinorUnits(0.005, "USD")).toBe(1);
    expect(toMinorUnits(0.004, "USD")).toBe(0);
    expect(toMinorUnits(1.235, "USD")).toBe(124);
  });

  it("treats zero-decimal currencies as already-integer", () => {
    expect(toMinorUnits(1500, "JPY")).toBe(1500);
    expect(toMinorUnits(1234.7, "KRW")).toBe(1235);
  });

  it("is case-insensitive on the currency code", () => {
    expect(toMinorUnits(10, "usd")).toBe(1000);
    expect(toMinorUnits(10, "jpy")).toBe(10);
  });
});
