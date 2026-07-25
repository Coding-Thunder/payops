import "server-only";

import { env } from "@/server/env";

/**
 * Server-side email allow-list. The ONLY gate on who can obtain an admin
 * session — enforced at OTP issuance, at OTP verification, and re-checked
 * in the session guard on every protected request. A valid Google account
 * that isn't on this list never gets past the OTP step.
 */
function allowSet(): Set<string> {
  return new Set(
    env.server.ADMIN_ALLOWLIST.split(",")
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0),
  );
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isAllowedEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return allowSet().has(normalizeEmail(email));
}
