import "server-only";

import crypto from "node:crypto";
import { Types } from "mongoose";

import {
  BetaApplicationStatus,
  type BetaUserType,
} from "@/lib/constants/beta";
import { ValidationError } from "@/lib/errors";
import type { RequestContext } from "@/server/api/request-context";
import { BetaApplication, type BetaApplicationDoc } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";

import { signupFounder, type SignupResult } from "./signup.service";

/**
 * Beta program — the public application + token-gated activation. Approval
 * and invitation happen in the admin console; this owns the submission
 * (public, no account) and the single-use-token activation that finally
 * provisions the workspace.
 */

/** sha256 of the raw token. The raw token is high-entropy (32 random bytes)
 *  so a plain hash at rest is safe — the token itself is the secret, and the
 *  hash is what both apps store/compare (no shared signing key needed). */
export function hashBetaToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("base64url");
}

function isDuplicateKey(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: number }).code === 11000
  );
}

/* ─── Public submission ────────────────────────────────────────────────── */

export interface SubmitBetaInput {
  fullName: string;
  email: string;
  userType: BetaUserType;
  businessName?: string | null;
  clientsManaged?: string | null;
  challengeAnswer?: string | null;
}

/**
 * Record a beta application. Deliberately returns void regardless of whether
 * the email already applied — the caller responds identically either way, so
 * the endpoint never leaks whether a given email is on file. One row per
 * email (unique index); a re-submit is a silent no-op and never resets a
 * decision already made. Never creates an account or workspace.
 */
export async function submitApplication(
  input: SubmitBetaInput,
): Promise<void> {
  await connectMongo();
  const email = input.email.toLowerCase().trim();
  const fullName = input.fullName.trim();
  if (!email || !fullName) return;

  const existing = await BetaApplication.findOne({ email })
    .select({ _id: 1 })
    .lean();
  if (existing) return; // already applied — silent, no enumeration

  try {
    await BetaApplication.create({
      fullName,
      email,
      userType: input.userType,
      businessName: input.businessName?.trim() || null,
      clientsManaged: input.clientsManaged?.trim() || null,
      challengeAnswer: input.challengeAnswer?.trim() || null,
      status: BetaApplicationStatus.PENDING,
    });
  } catch (err) {
    if (isDuplicateKey(err)) return; // lost a create race — still silent
    throw err;
  }
}

/* ─── Activation ───────────────────────────────────────────────────────── */

/**
 * Read-only token check for the /activate page. Returns the bound identity
 * to pre-fill (email is read-only) or null when the token is invalid,
 * expired, already used, or the application isn't in INVITED state.
 */
export async function getApplicationForActivation(
  rawToken: string,
): Promise<{ email: string; fullName: string; businessName: string | null } | null> {
  if (!rawToken || rawToken.length < 16) return null;
  await connectMongo();
  const app = await BetaApplication.findOne({
    "invite.tokenHash": hashBetaToken(rawToken),
    status: BetaApplicationStatus.INVITED,
  }).lean<(BetaApplicationDoc & { _id: Types.ObjectId }) | null>();
  if (!app || !app.invite) return null;
  if (app.invite.usedAt) return null;
  if (new Date(app.invite.expiresAt).getTime() < Date.now()) return null;
  return {
    email: app.email,
    fullName: app.fullName,
    businessName: app.businessName ?? null,
  };
}

/**
 * Activate an approved application: create the workspace bound to the
 * application's email and mark it ACTIVATED. The invitation is claimed
 * atomically (single-use) BEFORE provisioning so two concurrent clicks
 * can't both create an account; on a provisioning failure the claim is
 * rolled back so the applicant can retry. Returns the SignupResult so the
 * route can mint the session — identical to the normal signup response.
 */
export async function activateFromToken(
  rawToken: string,
  input: { name?: string; password: string },
  ctx: RequestContext | null,
): Promise<SignupResult> {
  await connectMongo();
  const now = new Date();

  // Atomic single-use claim: only one caller can flip usedAt from null.
  const app = await BetaApplication.findOneAndUpdate(
    {
      "invite.tokenHash": hashBetaToken(rawToken),
      status: BetaApplicationStatus.INVITED,
      "invite.usedAt": null,
      "invite.expiresAt": { $gt: now },
    },
    { $set: { "invite.usedAt": now } },
    { new: true },
  );
  if (!app) {
    throw new ValidationError(
      "This invitation link is invalid, expired, or has already been used.",
    );
  }

  const name = (input.name?.trim() || app.fullName).slice(0, 120) || "Founder";
  const orgName = (
    app.businessName?.trim() ||
    `${name}'s workspace`
  ).slice(0, 120);

  let result: SignupResult;
  try {
    // Email comes from the APPLICATION, never from client input — the token
    // is bound to the approved address.
    result = await signupFounder(
      { name, email: app.email, password: input.password, orgName },
      ctx,
    );
  } catch (err) {
    // Provisioning failed (e.g. an account already exists) — release the
    // single-use claim so a legitimate retry is possible.
    await BetaApplication.updateOne(
      { _id: app._id },
      { $set: { "invite.usedAt": null } },
    );
    throw err;
  }

  await BetaApplication.updateOne(
    { _id: app._id },
    {
      $set: {
        status: BetaApplicationStatus.ACTIVATED,
        activatedAt: new Date(),
        activatedUserId: new Types.ObjectId(result.user.id),
      },
    },
  );

  return result;
}
