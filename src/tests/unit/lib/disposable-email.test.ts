// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  DISPOSABLE_DOMAIN_COUNT,
  DISPOSABLE_EMAIL_MESSAGE,
  emailDomain,
  isDisposableEmail,
  isDisposableEmailDomain,
  normalizeEmail,
} from "@/lib/validation/disposable-email";
import { signupSchema } from "@/lib/validation/signup";

/**
 * Disposable-email rejection.
 *
 * The two failure modes pull in opposite directions and both are expensive:
 *
 *   - Letting a throwaway address through means a lead nobody can reach and a
 *     beta seat spent on a bot. `yopmail.com` was accepted before this.
 *   - Blocking a real prospect is WORSE and invisible — they leave without
 *     telling anyone. A large share of freelancers and small agencies, which
 *     is precisely this product's market, sign up with Gmail or Outlook.
 *
 * So the allowed cases below are as load-bearing as the blocked ones.
 */

const DISPOSABLE_SAMPLES = [
  "yopmail.com",
  "mailinator.com",
  "guerrillamail.com",
  "10minutemail.com",
  "temp-mail.org",
  "tempmail.com",
  "disposablemail.com",
  "throwawaymail.com",
  "trashmail.com",
  "sharklasers.com",
  "getnada.com",
  "maildrop.cc",
  "dispostable.com",
  "fakeinbox.com",
  "mailsac.com",
];

/**
 * Domains that MUST keep working. Free consumer mail is deliberately here:
 * blocking it would reject a large share of this product's actual buyers.
 */
const ALLOWED_SAMPLES = [
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "yahoo.com",
  "icloud.com",
  "proton.me",
  "protonmail.com",
  "fastmail.com",
  "zoho.com",
  "hey.com",
  "aol.com",
  "gmx.com",
  "tracetxn.com",
  "some-agency.co.uk",
  "studio.design",
  "consulting.com.au",
  "kunde.de",
];

describe("normalizeEmail", () => {
  it("lowercases and trims", () => {
    expect(normalizeEmail("  Ada@Example.COM  ")).toBe("ada@example.com");
  });

  it("returns null for anything that is not local@domain", () => {
    for (const bad of ["", "   ", "no-at-sign", "@example.com", "ada@", "ada@localhost", null, undefined]) {
      expect(normalizeEmail(bad as string), String(bad)).toBeNull();
    }
  });

  it("splits on the LAST @, so a quoted local part cannot smuggle a domain", () => {
    // "ada@yopmail.com"@example.com must be read as domain example.com,
    // not yopmail.com — and conversely a real address is unaffected.
    expect(emailDomain('"ada@example.com"@yopmail.com')).toBe("yopmail.com");
  });
});

describe("isDisposableEmail — blocked", () => {
  it.each(DISPOSABLE_SAMPLES)("rejects %s", (domain) => {
    expect(isDisposableEmail(`someone@${domain}`)).toBe(true);
  });

  it("rejects the exact address that was accepted before this existed", () => {
    expect(isDisposableEmail("test@yopmail.com")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isDisposableEmail("Test@YOPMAIL.com")).toBe(true);
    expect(isDisposableEmail("TEST@MailInator.COM")).toBe(true);
  });

  it("is whitespace-safe", () => {
    expect(isDisposableEmail("  test@yopmail.com  ")).toBe(true);
    expect(isDisposableEmail("\ttest@mailinator.com\n")).toBe(true);
  });

  it("catches wildcard subdomains, which is how these providers work", () => {
    // A provider handing out team.mailinator.com would otherwise bypass an
    // apex-only list entirely.
    expect(isDisposableEmail("a@team.mailinator.com")).toBe(true);
    expect(isDisposableEmail("a@x.y.z.yopmail.com")).toBe(true);
    expect(isDisposableEmailDomain("deep.sub.guerrillamail.com")).toBe(true);
  });

  it("ignores a trailing root dot", () => {
    expect(isDisposableEmailDomain("yopmail.com.")).toBe(true);
  });
});

describe("isDisposableEmail — allowed", () => {
  it.each(ALLOWED_SAMPLES)("accepts %s", (domain) => {
    expect(isDisposableEmail(`ada@${domain}`)).toBe(false);
  });

  it("never blanket-blocks a TLD", () => {
    // A single-label entry could otherwise take out every .com.
    expect(isDisposableEmailDomain("com")).toBe(false);
    expect(isDisposableEmailDomain("email")).toBe(false);
  });

  it("does not match a domain that merely CONTAINS a listed name", () => {
    // Substring matching would reject a legitimate business.
    for (const d of [
      "mailinator-consulting.com",
      "notyopmail.com",
      "tempmailservices.co",
      "my-temp-mail-agency.com",
    ]) {
      expect(isDisposableEmailDomain(d), d).toBe(false);
    }
  });

  it("handles malformed input without throwing or blocking", () => {
    for (const bad of ["", "   ", "not-an-email", null, undefined]) {
      expect(isDisposableEmail(bad as string), String(bad)).toBe(false);
    }
  });
});

describe("the denylist itself", () => {
  it("covers a meaningful number of providers", () => {
    expect(DISPOSABLE_DOMAIN_COUNT).toBeGreaterThan(80);
  });

  it("contains no free consumer provider", () => {
    // The regression that would quietly cost real signups.
    for (const d of ALLOWED_SAMPLES) {
      expect(isDisposableEmailDomain(d), `${d} must never be listed`).toBe(false);
    }
  });

  it("names no provider in the user-facing message", () => {
    expect(DISPOSABLE_EMAIL_MESSAGE).not.toMatch(/yopmail|mailinator|guerrilla/i);
    expect(DISPOSABLE_EMAIL_MESSAGE).toMatch(/work email/i);
  });
});

describe("enforcement at the schema boundary", () => {
  /**
   * The check lives in `signupSchema`, not in one route handler, so every
   * signup path inherits it. These assertions prove the wiring, not just the
   * predicate.
   */
  const valid = {
    name: "Ada Lovelace",
    email: "ada@example.com",
    // Matches the real password policy: uppercase + digit required.
    password: "Str0ng-Password",
    confirmPassword: "Str0ng-Password",
    orgName: "Ada Studio",
    acceptTerms: true,
  };

  it("rejects a disposable address through signupSchema", () => {
    const result = signupSchema.safeParse({ ...valid, email: "ada@yopmail.com" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toContain("work email");
    }
  });

  it("rejects it regardless of casing or padding", () => {
    for (const email of ["  ADA@YOPMAIL.COM ", "Ada@Mailinator.com"]) {
      expect(signupSchema.safeParse({ ...valid, email }).success, email).toBe(false);
    }
  });

  it("still accepts a legitimate address", () => {
    const result = signupSchema.safeParse(valid);
    if (!result.success) {
      // Surface the real reason if the fixture drifts from the schema.
      expect(JSON.stringify(result.error.issues)).toBe("");
    }
    expect(result.success).toBe(true);
  });
});
