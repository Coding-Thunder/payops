import "server-only";

import { timingSafeEqual } from "node:crypto";

/**
 * Public self-serve signup gate — CLOSED BY DEFAULT.
 *
 * During the private beta the only way to create an account is the beta
 * activation flow (a single-use invitation token, see
 * `beta-application.service`). This gate guards the legacy self-serve paths
 * (`/signup`, `/api/auth/signup`, firebase-session net-new provisioning): a
 * request is accepted ONLY when a break-glass `SIGNUP_INVITE_CODE` is
 * configured AND the exact code is presented. With no code configured — the
 * production default — every public signup is rejected and visitors are
 * routed to the beta waitlist. Existing users always sign in normally (the
 * gate only guards NET-NEW account provisioning).
 *
 * Reads `process.env` directly (not the cached `env` accessor) so the value
 * is always live — no stale cache, and tests can toggle it per-case.
 */

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

/** The configured break-glass code, or null when unset (gate fully closed). */
export function signupInviteCode(): string | null {
  const v = process.env.SIGNUP_INVITE_CODE;
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Whether a break-glass code is configured at all. */
export function signupsAreGated(): boolean {
  return signupInviteCode() !== null;
}

/**
 * Whether a presented code may create an account right now. Closed by
 * default: false unless a break-glass code is configured AND matches.
 */
export function signupInviteAccepted(
  presented: string | null | undefined,
): boolean {
  return codesMatch(presented, signupInviteCode());
}
