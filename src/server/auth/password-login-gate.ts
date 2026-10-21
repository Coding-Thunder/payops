import "server-only";

/**
 * Legacy Mongo-bcrypt sign-in — CLOSED BY DEFAULT.
 *
 * `/api/auth/login` authenticates against the bcrypt hash in Mongo, which is a
 * different authority from the one `/login` uses. Firebase is the live front
 * door: it is where a disabled identity, a revoked refresh token and a changed
 * password take effect. A route that checks only Mongo can therefore admit
 * someone Firebase would refuse — the state the two stores disagree about is
 * exactly the state that matters.
 *
 * Its only UI caller, `app/login/_components/login-form.tsx`, is dead code:
 * nothing imports it (its own test aside). What IS live is the Playwright
 * smoke suite, which uses this route as its only front door because driving a
 * real Firebase popup from a test browser is not possible. Deleting the route
 * would take the smoke suite with it, so it is gated rather than removed.
 *
 * Reads `process.env` directly, not the cached `env` accessor, so the value is
 * always live and a test can toggle it per-case — the same contract
 * `signup-gate.ts` uses.
 *
 * Deliberately NOT keyed on TRACETXN_TEST_MODE. That variable already
 * short-circuits the CSRF guard and every rate limiter, and widening its reach
 * would make one undeclared switch disable more of the perimeter at once. An
 * explicit, single-purpose flag is auditable: `printenv | grep -c
 * PASSWORD_LOGIN_ENABLED` answers "is the legacy door open?" in one command.
 */
export function passwordLoginEnabled(): boolean {
  return process.env.PASSWORD_LOGIN_ENABLED === "true";
}
