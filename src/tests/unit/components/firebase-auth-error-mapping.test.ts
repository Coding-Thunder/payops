import { describe, expect, it } from "vitest";

import { humanizeAuthError } from "@/components/auth/firebase-auth-form";
import { ApiClientError } from "@/lib/api-client";

/**
 * Sign-in error messages.
 *
 * The defect this pins is a real production one. `/login` renders
 * `FirebaseAuthForm` and authenticates ONLY against Firebase Auth, but the
 * Firebase migration was never backfilled: users who existed before it still
 * have a bcrypt hash in Mongo and no Firebase account, and Google-only users
 * have no password at all. All three failure shapes — no Firebase account,
 * wrong password, and Firebase's enumeration-protected `invalid-credential`
 * — reach the same branch, and the old message ("Incorrect email or
 * password.") sent those users back to retype a password that could never
 * work. `syncFirebasePassword` provisions the missing Firebase account the
 * first time a reset completes, so "Forgot password" is the actual fix, and
 * the message now says so.
 *
 * The competing constraint is that the branch is a security boundary: a
 * different string per Firebase code would turn the form into an account
 * oracle. So the tests below assert BOTH that the hint is present and that
 * it is byte-identical across all three codes.
 */

function fbError(code: string): unknown {
  return Object.assign(new Error(code), { code });
}

const CREDENTIAL_CODES = [
  "auth/user-not-found",
  "auth/wrong-password",
  "auth/invalid-credential",
];

describe("humanizeAuthError — credential failures", () => {
  it("returns one identical message for every credential code", () => {
    // The enumeration guarantee. If this ever splits, a caller can tell
    // "no such account" from "wrong password" by diffing the strings.
    const messages = new Set(
      CREDENTIAL_CODES.map((c) => humanizeAuthError(fbError(c), "signin")),
    );
    expect(messages.size).toBe(1);
  });

  it("points the user at recovery instead of only saying the password is wrong", () => {
    const msg = humanizeAuthError(fbError("auth/invalid-credential"), "signin");
    expect(msg).toMatch(/incorrect email or password/i);
    // The two routes out, for the two populations that legitimately land here.
    expect(msg).toMatch(/forgot password/i);
    expect(msg).toMatch(/google/i);
  });

  it("never reveals whether an account exists", () => {
    for (const code of CREDENTIAL_CODES) {
      const msg = humanizeAuthError(fbError(code), "signin");
      expect(msg).not.toMatch(/no account|not found|does not exist|unregistered/i);
      // Nor the raw Firebase code.
      expect(msg).not.toContain("auth/");
    }
  });

  it("keeps the signup message short — the hint is meaningless there", () => {
    const msg = humanizeAuthError(fbError("auth/invalid-credential"), "signup");
    expect(msg).toBe("Incorrect email or password.");
  });
});

describe("humanizeAuthError — other codes still map correctly", () => {
  it.each([
    ["auth/invalid-email", /valid email address/i],
    ["auth/email-already-in-use", /already exists/i],
    ["auth/weak-password", /stronger password/i],
    ["auth/too-many-requests", /too many failed attempts/i],
    ["auth/network-request-failed", /unable to connect/i],
    ["auth/popup-blocked", /blocked the google sign-in popup/i],
    ["auth/operation-not-allowed", /not enabled in the firebase project/i],
    ["auth/unauthorized-domain", /not authorized in the firebase project/i],
  ])("%s", (code, expected) => {
    expect(humanizeAuthError(fbError(code), "signin")).toMatch(expected);
  });

  it("surfaces a server-side exchange error verbatim", () => {
    // After Firebase succeeds, /api/auth/firebase-session can still refuse
    // (unverified email, private-beta gate, inactive account). Those
    // messages are written for the user and must not be swallowed.
    const err = new ApiClientError(401, {
      code: "UNAUTHORIZED",
      message:
        "Please verify your email address with your sign-in provider before continuing.",
    });
    expect(humanizeAuthError(err, "signin")).toBe(
      "Please verify your email address with your sign-in provider before continuing.",
    );
  });

  it("falls back without leaking the raw code for an unknown failure", () => {
    const msg = humanizeAuthError(fbError("auth/some-new-code"), "signin");
    expect(msg).not.toContain("auth/");
    expect(msg).toMatch(/could not sign in/i);
  });

  it("handles a non-Firebase throwable", () => {
    expect(humanizeAuthError(new Error("boom"), "signin")).toMatch(
      /could not sign in/i,
    );
    expect(humanizeAuthError(null, "signup")).toMatch(
      /could not create your account/i,
    );
  });
});
