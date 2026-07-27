import "server-only";

import { timingSafeEqual } from "node:crypto";

import { env } from "@/lib/env";

/**
 * Private-beta signup gate.
 *
 * Self-serve account creation is invite-only WHENEVER `SIGNUP_INVITE_CODE`
 * is configured. A visitor must present the matching code (carried by the
 * `/signup?invite=…` link) to reach the signup form or provision a
 * workspace; everyone else is routed to the beta waitlist. When the env var
 * is unset the gate is inactive and signup behaves exactly as before — so
 * the founder turns the private beta on/off purely by setting/clearing one
 * value, with zero code change. Existing users always sign in normally
 * (the gate only guards NET-NEW account provisioning).
 */

/** Constant-time equality that never short-circuits on length (still safe:
 *  a length mismatch simply returns false). */
export function codesMatch(
  presented: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (!expected) return true; // gate disabled → everything is accepted
  if (typeof presented !== "string" || presented.length === 0) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** The configured beta invite code, or null when the gate is off. */
export function signupInviteCode(): string | null {
  return env.server.SIGNUP_INVITE_CODE ?? null;
}

/** True when signup is currently invite-gated (a code is configured). */
export function signupsAreGated(): boolean {
  return signupInviteCode() !== null;
}

/**
 * Whether a presented invite code may create an account right now. Returns
 * true unconditionally when the gate is off, so callers can use this as the
 * single decision point without branching on `signupsAreGated()`.
 */
export function signupInviteAccepted(
  presented: string | null | undefined,
): boolean {
  return codesMatch(presented, signupInviteCode());
}
