import "server-only";

import { timingSafeEqual } from "node:crypto";

/**
 * Who may create a brand-new account.
 *
 * ── The change, and why the default inverted ─────────────────────────────
 *
 * This used to be CLOSED BY DEFAULT: during the private beta the only way in
 * was an emailed, single-use activation token, and self-serve signup was
 * refused unless an operator configured a break-glass `SIGNUP_INVITE_CODE`
 * and the visitor presented it. The private beta is over, so the default is
 * now OPEN — a stranger can register without an invitation.
 *
 * The gate is inverted rather than deleted, for two reasons. It stays the one
 * place that answers "can a stranger create an account right now?", which is
 * a question worth being able to answer in one file. And closing signup again
 * — for an incident, an abuse wave, or a return to invite-only — is then a
 * config change rather than a code change.
 *
 * ── What still protects the open door ────────────────────────────────────
 *
 * Opening signup does NOT mean an unverified email can own an account. The
 * public path is the Firebase client flow behind `/signup`, which proves the
 * visitor controls the address before anything is provisioned:
 *
 *   - email + password → Firebase creates an UNVERIFIED identity, the form
 *     sends a verification mail, and `firebaseExchange` refuses to provision
 *     until `email_verified` is true. The mailbox is the proof.
 *   - Google → the provider asserts a verified address.
 *
 * `POST /api/auth/signup` deliberately did NOT become public. It provisions
 * through `signupFounder`, which calls `syncFirebasePassword` and so marks the
 * identity `emailVerified: true` for an address the caller merely typed. Behind
 * an invite code that is contained; open to the internet it would let anyone
 * squat any address AND mint a Firebase identity that `firebaseExchange` later
 * trusts for account LINKING — the anti-takeover guard reads that same flag.
 * So that route keeps requiring the code, and the ownership-proving flow is
 * the public one.
 *
 * ── Known gap: disposable addresses ──────────────────────────────────────
 *
 * The denylist in `@/lib/validation/disposable-email` guards `signupSchema`,
 * and `signupSchema` guards only `POST /api/auth/signup` — the invite-gated
 * route with no production caller. The path that is actually public does not
 * consult it, so `anything@yopmail.com` can register. Email verification is
 * not a substitute: a disposable inbox satisfies it, which is the reason the
 * list was written in the first place.
 *
 * Left open deliberately, not overlooked. Adding the check here would reject
 * the address only AFTER Firebase has minted the identity, which strands the
 * visitor holding an account the server will never accept and no way to
 * recover — the same orphan state this flow was rebuilt to stop creating.
 * Doing it properly means checking the domain before `createUserWithEmail`,
 * which is a separate change. The cost of waiting is junk free tenants and a
 * welcome email each.
 *
 * Reads `process.env` directly rather than the cached `env` accessor, so the
 * value is always live and a test can toggle it per case.
 */

/**
 * Accepted values of `SIGNUP_MODE`.
 *
 * `src/lib/env.ts` declares the variable as a strict enum, so an unknown
 * value fails env validation at boot — loud at deploy time, which is what you
 * want from the flag that decides who may register. The leniency below is the
 * last line of defence for callers that read `process.env` without going
 * through `env` (tests, one-off scripts): an unrecognised value reads as
 * `public` rather than silently locking every new user out.
 */
export type SignupMode = "public" | "invite_only";

/**
 * Current mode. `public` unless `SIGNUP_MODE=invite_only` is set explicitly.
 *
 * Spelled as a positive mode rather than a `SIGNUP_CLOSED` boolean because a
 * negative flag read under pressure is easy to get backwards, and this one
 * decides whether strangers can register.
 */
export function signupMode(): SignupMode {
  return process.env.SIGNUP_MODE === "invite_only" ? "invite_only" : "public";
}

/** Whether a stranger may register with no invitation at all. */
export function publicSignupOpen(): boolean {
  return signupMode() === "public";
}

/** Constant-time equality; a length mismatch simply returns false. */
export function codesMatch(
  presented: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (!expected) return false; // no configured code → nothing is accepted
  if (typeof presented !== "string" || presented.length === 0) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** The configured break-glass code, or null when unset. */
export function signupInviteCode(): string | null {
  const v = process.env.SIGNUP_INVITE_CODE;
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Whether signup is closed to anyone without the break-glass code. */
export function signupsAreGated(): boolean {
  return signupMode() === "invite_only";
}

/**
 * Whether a presented code is a valid break-glass invite.
 *
 * Unchanged in meaning: it answers only "is this code correct", never "may
 * this person sign up". Callers that want the latter use `signupAllowed`, so
 * reopening signup could not accidentally turn a wrong code into an accepted
 * one.
 */
export function signupInviteAccepted(
  presented: string | null | undefined,
): boolean {
  return codesMatch(presented, signupInviteCode());
}

/**
 * The question every signup path actually asks: may THIS request create a
 * net-new account?
 *
 * Open mode: yes. Invite-only mode: only with the exact code — which keeps
 * any `?invite=…` link already in circulation working after a re-close.
 */
export function signupAllowed(
  presentedCode: string | null | undefined,
): boolean {
  if (publicSignupOpen()) return true;
  return signupInviteAccepted(presentedCode);
}
