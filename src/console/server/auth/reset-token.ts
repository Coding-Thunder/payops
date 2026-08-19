import "server-only";

import { generateResetToken } from "@/server/services/password-reset.service";
import { env } from "@/console/server/env";

/**
 * Set-password links minted by the console.
 *
 * There is exactly ONE token implementation: the main app's
 * `generateResetToken` in `src/server/services/password-reset.service.ts`,
 * which is also the module that redeems it (`completePasswordReset`). This
 * file only re-exports it and builds the URL.
 *
 * It used to be a hand-copied "EXACT replica" of that scheme. It wasn't: the
 * copy encoded `passwordHash.slice(0, 8)` while the main app moved to
 * `sha256(passwordHash).base64url.slice(0, 16)`. Nothing failed loudly — the
 * HMAC still verified, and the token died at the head comparison with
 * "This reset link is no longer valid, the password has already been
 * changed." Every link the console ever sent was unredeemable. Re-exporting
 * is what makes that class of drift impossible rather than merely unlikely.
 *
 * A side benefit: the canonical head is base64url, whose alphabet has no
 * ".", so the payload's 4-part split can no longer be broken by a dot in a
 * bcrypt salt. The caller-side guard that used to reject such users is gone.
 */
export { generateResetToken };

export function buildSetPasswordUrl(token: string): string {
  const base = env.server.MAIN_APP_URL.replace(/\/$/, "");
  return `${base}/reset-password/${token}`;
}
