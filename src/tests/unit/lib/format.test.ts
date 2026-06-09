import { describe, expect, it } from "vitest";

import {
  formatCurrency,
  formatDate,
  formatDateTime,
  formatRelative,
  initialsFromName,
} from "@/lib/format";

describe("formatCurrency", () => {
  it("formats USD with two-decimal precision", () => {
    expect(formatCurrency(1234.5, "USD")).toBe("$1,234.50");
  });

  it("uppercases the currency before lookup", () => {
    const out = formatCurrency(10, "eur");
    expect(out).toContain("€");
    expect(out).toMatch(/10\.00/);
  });

  it("renders unknown currency codes with the code as prefix", () => {
    // Intl.NumberFormat doesn't throw on unknown ISO codes, it just
    // prefixes the code (with a NBSP separator). We assert structurally
    // so the test isn't tied to the exact whitespace character.
    const out = formatCurrency(42, "ZZZ");
    expect(out.replace(/\s/g, " ")).toBe("ZZZ 42.00");
  });
});

describe("formatDate / formatDateTime", () => {
  it("returns an em dash for null / undefined", () => {
    expect(formatDate(null)).toBe("-");
    expect(formatDate(undefined)).toBe("-");
  });

  it("returns an em dash for an unparseable string", () => {
    expect(formatDate("not-a-date")).toBe("-");
  });

  it("formats a valid ISO string in en-US short form", () => {
    const out = formatDate("2025-08-14T12:00:00.000Z");
    expect(out).toMatch(/Aug \d{2}, 2025/);
  });

  it("formatDateTime includes a time component", () => {
    const out = formatDateTime("2025-08-14T15:30:00.000Z");
    expect(out).toMatch(/\d{1,2}:\d{2}/);
  });
});

describe("formatRelative", () => {
  it("returns an em dash for empty input", () => {
    expect(formatRelative(null)).toBe("-");
  });

  it("returns a seconds-scale label for a near-now date", () => {
    const d = new Date(Date.now() - 5_000);
    const out = formatRelative(d);
    expect(out).toMatch(/second/);
  });

  it("returns a days-scale label for a date one week ago", () => {
    const d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    expect(formatRelative(d)).toMatch(/day/);
  });
});

describe("initialsFromName", () => {
  it("uses two letters from a single-word name", () => {
    expect(initialsFromName("Madonna")).toBe("MA");
  });

  it("combines first and last initials for multi-word names", () => {
    expect(initialsFromName("Ada Lovelace")).toBe("AL");
    expect(initialsFromName("  John   Ronald  Tolkien  ")).toBe("JT");
  });

  it("uppercases the result regardless of source case", () => {
    expect(initialsFromName("grace hopper")).toBe("GH");
  });
});
