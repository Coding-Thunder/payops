import "server-only";

import { env } from "@/server/env";
import { connectMongo } from "@/server/db/mongoose";
import { AdminUser } from "@/server/db/models";

/**
 * Who can obtain an admin session. The authoritative list now lives in the
 * DB (`admin_users`, managed from the Admins page); the env `ADMIN_ALLOWLIST`
 * is a BREAK-GLASS bootstrap that is always allowed, so an empty or
 * write-broken collection can never lock every founder out.
 *
 * Enforced at OTP issuance, at OTP verification, and re-checked in the
 * session guard on every protected request — so disabling an admin (or
 * removing them from the bootstrap env) revokes access on the next request
 * even with a still-valid cookie.
 */

/** Break-glass admins from env — always allowed, even if the DB is empty or
 *  briefly unreachable. Managed admins live in the DB. */
export function bootstrapAdmins(): Set<string> {
  return new Set(
    env.server.ADMIN_ALLOWLIST.split(",")
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0),
  );
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Whether an email is a break-glass bootstrap admin (env-configured). Such
 *  admins can't be removed via the Admins page — edit the env to revoke. */
export function isBootstrapEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return bootstrapAdmins().has(normalizeEmail(email));
}

/**
 * DB-backed allow-list check. Allowed when the email is a bootstrap admin OR
 * an ACTIVE row in `admin_users`. Async (queries Mongo). Fails closed for
 * DB-managed admins if Mongo is unreachable, while bootstrap admins (checked
 * first, no DB needed) always retain access.
 */
export async function isAllowedEmail(
  email: string | null | undefined,
): Promise<boolean> {
  if (!email) return false;
  const normalized = normalizeEmail(email);
  if (bootstrapAdmins().has(normalized)) return true;
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
