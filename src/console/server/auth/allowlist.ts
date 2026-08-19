import "server-only";

import { connectMongo } from "@/console/server/db/mongoose";
import { AdminUser } from "@/console/server/db/models";

/**
 * Who can obtain an admin session.
 *
 * The `admin_users` collection is the ONLY source of truth. There is no
 * environment-configured bootstrap/break-glass list: an env var that always
 * grants platform-admin access is a credential that never expires, can't be
 * revoked from the console, and silently outranks the audit trail.
 *
 * Enforced at OTP issuance, at OTP verification, and re-checked in the session
 * guard on every protected request — so disabling an admin revokes access on
 * the next request even with a still-valid cookie.
 *
 * OPERATIONAL CONSEQUENCE, by design: if `admin_users` has no ACTIVE row, or
 * Mongo is unreachable, nobody can sign in and the application offers no way
 * back. Recovery is a direct insert into `admin_users`:
 *
 *   db.admin_users.insertOne({
 *     email: "you@example.com", name: "You", role: "OWNER",
 *     status: "ACTIVE", invitedByEmail: null, lastLoginAt: null,
 *     createdAt: new Date(), updatedAt: new Date(),
 *   })
 *
 * That is deliberate: recovery requires database access, not an env var.
 */

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * DB-backed allow-list check. Allowed only when the email has an ACTIVE row in
 * `admin_users`. Fails CLOSED when Mongo is unreachable — an outage must not
 * widen access.
 */
export async function isAllowedEmail(
  email: string | null | undefined,
): Promise<boolean> {
  if (!email) return false;
  const normalized = normalizeEmail(email);
  try {
    await connectMongo();
    const found = await AdminUser.findOne({
      email: normalized,
      status: "ACTIVE",
    })
      .select({ _id: 1 })
      .lean();
    return Boolean(found);
  } catch (err) {
    console.error(
      `[admin] allow-list DB check failed for ${normalized}:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}
