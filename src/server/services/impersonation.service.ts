import "server-only";

import { jwtVerify } from "jose";
import { Schema, type Model } from "mongoose";

import { env } from "@/lib/env";
import { connectMongo } from "@/server/db/mongoose";
import { registerModel } from "@/server/db/models/register";

/**
 * Founder-console user impersonation — MAIN-APP side (verify + consume).
 *
 * The console (a separate app on a separate origin) can't set this app's
 * session cookie, so it mints a short-lived, single-use handoff token
 * signed with the SHARED `IMPERSONATION_SECRET` and redirects the operator
 * to `/api/impersonate/start`. This module verifies that token and burns
 * its `jti` so it can never be replayed. The token grants NOTHING on its
 * own — the start route mints the actual (short-TTL, observe-only,
 * banner-flagged, audited) session.
 *
 * Disabled entirely when `IMPERSONATION_SECRET` is unset.
 */

const ISSUER = "tracetxn:console";
const AUDIENCE = "tracetxn:impersonate";

interface ImpersonationGrantDoc {
  jti: string;
  targetUserId: string;
  by: string;
  usedAt: Date;
}

const grantSchema = new Schema<ImpersonationGrantDoc>(
  {
    jti: { type: String, required: true, unique: true },
    targetUserId: { type: String, required: true },
    by: { type: String, required: true },
    usedAt: { type: Date, required: true, default: () => new Date() },
  },
  { versionKey: false, collection: "impersonation_grants" },
);
grantSchema.index({ usedAt: 1 }, { expireAfterSeconds: 600 });

const ImpersonationGrant: Model<ImpersonationGrantDoc> =
  registerModel<ImpersonationGrantDoc>("ImpersonationGrant", grantSchema);

// Prod runs with autoIndex off, so the single-use guarantee (the unique
// jti index) is NOT auto-built. Ensure it explicitly on first use — a
// no-op if it already exists — so replay protection is never silently
// missing. Cached per process.
let indexesEnsured = false;
async function ensureIndexes(): Promise<void> {
  if (indexesEnsured) return;
  await ImpersonationGrant.collection.createIndex(
    { jti: 1 },
    { unique: true, name: "impersonation_jti_unique" },
  );
  await ImpersonationGrant.collection.createIndex(
    { usedAt: 1 },
    { expireAfterSeconds: 600, name: "impersonation_ttl" },
  );
  indexesEnsured = true;
}

export function impersonationEnabled(): boolean {
  return Boolean(env.server.IMPERSONATION_SECRET);
}

export interface ImpersonationGrantResult {
  targetUserId: string;
  by: string;
  observeOnly: boolean;
}

/**
 * Verify a console handoff token and atomically burn its `jti`. Returns the
 * grant on success, or null on any failure (disabled, bad signature/claims,
 * expired, or replay). Observe-only is the default: full-action requires an
 * explicit `obs:false` claim.
 */
export async function verifyAndConsumeImpersonationToken(
  token: string,
): Promise<ImpersonationGrantResult | null> {
  const secret = env.server.IMPERSONATION_SECRET;
  if (!secret || !token) return null;

  let claims;
  try {
    ({ payload: claims } = await jwtVerify(
      token,
      new TextEncoder().encode(secret),
      { issuer: ISSUER, audience: AUDIENCE, algorithms: ["HS256"] },
    ));
  } catch {
    return null;
  }

  const targetUserId = claims.sub;
  const by = claims.by;
  const jti = claims.jti;
  if (
    typeof targetUserId !== "string" ||
    typeof by !== "string" ||
    typeof jti !== "string"
  ) {
    return null;
  }
  const observeOnly = claims.obs !== false;

  await connectMongo();
  await ensureIndexes();
  try {
    await ImpersonationGrant.create({
      jti,
      targetUserId,
      by,
      usedAt: new Date(),
    });
  } catch (err) {
    // Duplicate jti = replay of an already-consumed token.
    if ((err as { code?: number })?.code === 11000) return null;
    throw err;
  }

  return { targetUserId, by, observeOnly };
}
