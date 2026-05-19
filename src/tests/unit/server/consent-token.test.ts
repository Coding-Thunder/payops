// @vitest-environment node

import { describe, expect, it } from "vitest";

import { BadRequestError } from "@/lib/errors";
import {
  buildConsentUrl,
  generateConsentToken,
  parseConsentToken,
} from "@/server/services/consent-token";

describe("consent token", () => {
  const id = "507f1f77bcf86cd799439011";

  it("round-trips through generate + parse", () => {
    const token = generateConsentToken(id);
    const parsed = parseConsentToken(token);
    expect(parsed.consentId).toBe(id);
    expect(typeof parsed.issuedAtSec).toBe("number");
  });

  it("produces tokens that are URL-safe (base64url alphabet)", () => {
    const token = generateConsentToken(id);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("rejects a tampered signature", () => {
    const token = generateConsentToken(id);
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const dot = decoded.lastIndexOf(".");
    const tampered = Buffer.from(
      `${decoded.slice(0, dot)}.${"x".repeat(decoded.length - dot - 1)}`,
      "utf8",
    ).toString("base64url");
    expect(() => parseConsentToken(tampered)).toThrow(BadRequestError);
  });

  it("rejects a token with no signature segment", () => {
    const bogus = Buffer.from("just-an-id", "utf8").toString("base64url");
    expect(() => parseConsentToken(bogus)).toThrow(BadRequestError);
  });

  it("rejects non-base64url input", () => {
    expect(() => parseConsentToken("***")).toThrow(BadRequestError);
  });

  it("buildConsentUrl strips trailing slashes from the app URL", () => {
    expect(buildConsentUrl("https://app.example.com/", "abc")).toBe(
      "https://app.example.com/consent/abc",
    );
    expect(buildConsentUrl("https://app.example.com", "abc")).toBe(
      "https://app.example.com/consent/abc",
    );
  });
});
