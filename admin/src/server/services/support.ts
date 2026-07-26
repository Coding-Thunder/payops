import "server-only";

import { connectMongo } from "@/server/db/mongoose";
import { User, Types } from "@/server/db/models";
import {
  buildSetPasswordUrl,
  generateResetToken,
  passwordHashHead,
} from "@/server/auth/reset-token";
import { sendAccessLinkEmail } from "@/server/email/mailer";

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

  const hash = u.passwordHash ?? "";
  // The token embeds the first 8 chars of the bcrypt hash and the main app
  // splits the payload on "." into exactly 4 parts — a dot in the hash head
  // (~1/64 of bcrypt salts) would break the link. Refuse rather than send a
  // dead link; the user can use self-service "Forgot password" instead.
  if (hash && passwordHashHead(hash).includes(".")) {
    return {
      ok: false,
      message:
        "Can't mint a reset link for this account — ask the user to use “Forgot password” on the sign-in page.",
    };
  }

  const token = generateResetToken(String(u._id), hash);
  const url = buildSetPasswordUrl(token);
  try {
    await sendAccessLinkEmail({ to: u.email, name: u.name ?? u.email, url });
  } catch (err) {
    console.error("[admin] reset-link email failed", err);
    return { ok: false, message: "Could not send the email — check email logs." };
  }
  return { ok: true };
}
