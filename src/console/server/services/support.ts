import "server-only";

import { connectMongo } from "@/console/server/db/mongoose";
import { User, Types } from "@/console/server/db/models";
import {
  buildSetPasswordUrl,
  generateResetToken,
} from "@/console/server/auth/reset-token";
import { sendAccessLinkEmail } from "@/console/server/email/mailer";

/**
 * Support actions that operate on main-app users. These trigger existing
 * main-app flows (a set-password/reset link that validates on the main
 * app's /reset-password route) rather than mutating auth state directly.
 */

export interface SupportResult {
  ok: boolean;
  message?: string;
}

/**
 * Email the user a password-reset / set-password link. Mints a token with
 * the SAME scheme the main app's password-reset service uses, so the link
 * works unchanged. Works for password users (resets) and Firebase-only
 * users (lets them set a first password).
 */
export async function sendUserPasswordReset(
  id: string,
): Promise<SupportResult> {
  if (!Types.ObjectId.isValid(id)) return { ok: false, message: "Invalid id" };
  await connectMongo();
  const u = await User.findById(new Types.ObjectId(id))
    .select({ email: 1, name: 1, passwordHash: 1 })
    .lean<{
      _id: Types.ObjectId;
      email?: string;
      name?: string;
      passwordHash?: string | null;
    } | null>();
  if (!u || !u.email) return { ok: false, message: "User not found" };

  // `completePasswordReset` binds the token to the CURRENT password hash and
  // reads `user.passwordHash` when redeeming. An account with no password
  // (Firebase-only) has nothing to bind to, and the redeem path would throw
  // rather than let them set a first one — so refuse with something the
  // operator can act on instead of emailing a link that 500s.
  const hash = u.passwordHash ?? "";
  if (!hash) {
    return {
      ok: false,
      message:
        "This account signs in with Google and has no password to reset — ask them to use “Continue with Google”.",
    };
  }

  const token = generateResetToken({ _id: u._id, passwordHash: hash });
  const url = buildSetPasswordUrl(token);
  try {
    await sendAccessLinkEmail({ to: u.email, name: u.name ?? u.email, url });
  } catch (err) {
    console.error("[admin] reset-link email failed", err);
    return { ok: false, message: "Could not send the email — check email logs." };
  }
  return { ok: true };
}
