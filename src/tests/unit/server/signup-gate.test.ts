import { describe, expect, it } from "vitest";

import { beforeEach, afterEach } from "vitest";

import {
  codesMatch,
  publicSignupOpen,
  signupAllowed,
  signupMode,
  signupsAreGated,
} from "@/server/auth/signup-gate";

/**
 * The signup access model.
 *
 * `codesMatch` is unchanged: it is still the pure comparison behind the
 * break-glass invite code, and it still refuses everything when no code is
 * configured. What changed is the DEFAULT above it. Signup used to be closed
 * unless a code was configured and presented — and since no `SIGNUP_INVITE_CODE`
 * was ever set, that meant every visitor to /signup was redirected to
 * /waitlist and the form never rendered. The private beta is over, so
 * `signupAllowed` now says yes by default and `SIGNUP_MODE=invite_only`
 * restores the old behaviour.
 *
 * The two functions are kept separate on purpose: `signupInviteAccepted`
 * answers only "is this code correct", never "may this person sign up", so
 * reopening signup could not turn a wrong code into an accepted one.
 */
describe("codesMatch (signup gate)", () => {
  it("rejects everything when no code is configured (closed by default)", () => {
    expect(codesMatch("whatever", null)).toBe(false);
    expect(codesMatch(undefined, undefined)).toBe(false);
    expect(codesMatch("", "")).toBe(false);
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

describe("signup access mode", () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.SIGNUP_MODE;
    delete process.env.SIGNUP_MODE;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.SIGNUP_MODE;
    else process.env.SIGNUP_MODE = saved;
  });

  it("is PUBLIC by default — a stranger may register with no invitation", () => {
    expect(signupMode()).toBe("public");
    expect(publicSignupOpen()).toBe(true);
    expect(signupAllowed(undefined)).toBe(true);
    expect(signupAllowed(null)).toBe(true);
    expect(signupAllowed("")).toBe(true);
  });

  it("closes again on exactly SIGNUP_MODE=invite_only", () => {
    process.env.SIGNUP_MODE = "invite_only";
    expect(signupMode()).toBe("invite_only");
    expect(publicSignupOpen()).toBe(false);
    expect(signupsAreGated()).toBe(true);
    // No code configured, so nothing is accepted — the old posture exactly.
    expect(signupAllowed(undefined)).toBe(false);
    expect(signupAllowed("anything")).toBe(false);
  });

  it("honours an invite link already in circulation after a re-close", () => {
    process.env.SIGNUP_MODE = "invite_only";
    process.env.SIGNUP_INVITE_CODE = "still-valid-code";
    try {
      expect(signupAllowed("still-valid-code")).toBe(true);
      expect(signupAllowed("wrong-code")).toBe(false);
    } finally {
      delete process.env.SIGNUP_INVITE_CODE;
    }
  });

  it("treats any other value as public, rather than failing shut on a typo", () => {
    // A misspelled mode must not silently lock every new user out of a
    // product whose marketing now invites them to sign up. The deliberate
    // closed state has exactly one spelling.
    for (const v of ["invite-only", "inviteOnly", "INVITE_ONLY", "closed", "1", ""]) {
      process.env.SIGNUP_MODE = v;
      expect(signupAllowed(undefined), `"${v}" must not close signup`).toBe(true);
    }
  });

  it("never lets the mode override a wrong code in invite_only", () => {
    process.env.SIGNUP_MODE = "invite_only";
    process.env.SIGNUP_INVITE_CODE = "real";
    try {
      expect(signupAllowed("REAL")).toBe(false);
      expect(signupAllowed("rea")).toBe(false);
      expect(signupAllowed("real-extra")).toBe(false);
    } finally {
      delete process.env.SIGNUP_INVITE_CODE;
    }
  });
});
