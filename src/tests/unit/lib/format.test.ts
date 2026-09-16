import { describe, expect, it } from "vitest";

import {
  formatCurrency,
  formatDate,
  formatDateTime,
  formatRelative,
  formatDateTimeUtc,
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
    // Intl.NumberFormat doesn't throw on unknown ISO codes — it just
    // prefixes the code (with a NBSP separator). We assert structurally
    // so the test isn't tied to the exact whitespace character.
    const out = formatCurrency(42, "ZZZ");
    expect(out.replace(/\s/g, " ")).toBe("ZZZ 42.00");
  });
});

describe("formatDate / formatDateTime", () => {
  it("returns an em dash for null / undefined", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate(undefined)).toBe("—");
  });

  it("returns an em dash for an unparseable string", () => {
    expect(formatDate("not-a-date")).toBe("—");
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
    expect(formatRelative(null)).toBe("—");
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

/**
 * The consent page server-renders for a CUSTOMER and then hydrates. Any
 * byte-level difference between the two passes is a hydration mismatch, and
 * React 19 responds by discarding the server HTML for that subtree — which
 * is what left the signature input with no event handlers attached and
 * produced the "signature box is not clickable" reports.
 *
 * Two independent sources of divergence, both guarded here.
 */
describe("formatDateTimeUtc — hydration-safe by construction", () => {
  const INSTANT = "2026-04-02T08:00:00.000Z";

  it("contains no ICU-version-dependent separator", () => {
    // The real trap: pinning timeZone:'UTC' does NOT make Intl stable,
    // because CLDR 42+ (Chrome 110+, current mobile Safari) emits U+202F
    // NARROW NO-BREAK SPACE before AM/PM where older ICU emits U+0020.
    // Same instant, same zone, different bytes, broken hydration.
    const out = formatDateTimeUtc(INSTANT);
    expect(out).not.toContain(" ");
    expect(out).not.toContain(" ");
    // ASCII only — nothing locale-dependent can have crept in.
    expect(/^[\x20-\x7E]+$/.test(out)).toBe(true);
  });

  it("is identical regardless of the host timezone", () => {
    const original = process.env.TZ;
    try {
      const seen = new Set<string>();
      for (const tz of ["UTC", "America/New_York", "Asia/Kolkata", "Pacific/Auckland"]) {
        process.env.TZ = tz;
        seen.add(formatDateTimeUtc(INSTANT));
      }
      // One distinct rendering across every zone: server and client agree
      // no matter where the customer is.
      expect(seen.size).toBe(1);
    } finally {
      process.env.TZ = original;
    }
  });

  it("renders the instant in UTC and says so", () => {
    expect(formatDateTimeUtc(INSTANT)).toBe("Apr 02, 2026, 08:00 UTC");
  });

  it("degrades to an em dash rather than throwing", () => {
    expect(formatDateTimeUtc(null)).toBe("—");
    expect(formatDateTimeUtc(undefined)).toBe("—");
    expect(formatDateTimeUtc("not a date")).toBe("—");
  });
});
