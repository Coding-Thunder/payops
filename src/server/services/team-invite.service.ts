import "server-only";

import crypto from "node:crypto";

import { Types } from "mongoose";

import {
  AuditAction,
  AuditEntity,
  RecordState,
  UserRole,
} from "@/lib/constants/enums";
import { UserRoleLabel } from "@/lib/constants/labels";
import {
  TEAM_INVITE_TTL_DAYS,
  TEAM_INVITE_TTL_MS,
} from "@/lib/constants/team";
import { env } from "@/lib/env";
import { NotFoundError, ValidationError } from "@/lib/errors";
import {
  OrgMember,
  Organization,
  User,
  type TeamInvite,
} from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import { syncFirebasePassword } from "@/server/auth/firebase-password";
import { hashPassword } from "@/server/auth/password";
import type { RequestContext } from "@/server/api/request-context";

import { recordAudit } from "./audit.service";
import { sendTeamInviteEmail } from "./email.service";

const EXPIRES_LABEL = `${TEAM_INVITE_TTL_DAYS} days`;

/**
 * Hash a raw invite token for at-rest storage. Only the sha256→base64url
 * hash is ever persisted; the raw token lives solely in the emailed /join
 * link. (Same construction as the beta hash — no shared signing key, both
 * ends just hash + compare.)
 */
export function hashInviteToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("base64url");
}

/** Derive a member's invite status from their OrgMember.invite subdoc.
 *  No invite (legacy / never-invited) or a used one → "active". */
export function deriveInviteStatus(
  invite?: { usedAt?: Date | null } | null,
): "invited" | "active" {
  return !invite || invite.usedAt ? "active" : "invited";
}

/** Mint a fresh single-use invite: a 256-bit random token (returned raw for
 *  the email) + the persistable subdoc holding only its hash. */
export function mintTeamInvite(): { rawToken: string; invite: TeamInvite } {
  const rawToken = crypto.randomBytes(32).toString("base64url");
  return {
    rawToken,
    invite: {
      tokenHash: hashInviteToken(rawToken),
      expiresAt: new Date(Date.now() + TEAM_INVITE_TTL_MS),
      sentAt: null,
      usedAt: null,
    },
  };
}

/** Absolute /join URL carrying the raw token. */
export function buildJoinUrl(rawToken: string): string {
  return `${env.server.APP_URL.replace(/\/$/, "")}/join/${rawToken}`;
}

/**
 * Dispatch the invite email for a member. `required: true` inside
 * sendTeamInviteEmail means this THROWS on a non-delivery so the caller can
 * roll back / surface a hard error. Never logs the raw token.
 */
export async function dispatchTeamInvite(args: {
  to: string;
  inviteeName: string;
  role: UserRole;
  orgName: string;
  inviterName: string;
  rawToken: string;
}): Promise<void> {
  await sendTeamInviteEmail({
    to: args.to,
    inviteeName: args.inviteeName,
    orgName: args.orgName,
    inviterName: args.inviterName,
    role: UserRoleLabel[args.role],
    joinUrl: buildJoinUrl(args.rawToken),
    expiresLabel: EXPIRES_LABEL,
  });
}

/**
 * Read-only precheck for the /join page. Returns the bound identity to
 * pre-fill (email is read-only) or null when the token is invalid, expired,
 * already used, or not an outstanding invite. Enumeration-safe: every
 * failure mode returns the same null.
 */
export async function getInviteForActivation(
  rawToken: string,
): Promise<{ email: string; defaultName: string; orgName: string } | null> {
  if (!rawToken || rawToken.length < 16) return null;
  await connectMongo();
  const member = await OrgMember.findOne({
    "invite.tokenHash": hashInviteToken(rawToken),
  })
    .select({ userId: 1, orgId: 1, invite: 1 })
    .lean<{
      userId: Types.ObjectId;
      orgId: Types.ObjectId;
      invite?: TeamInvite | null;
    } | null>();
  if (!member || !member.invite) return null;
  if (member.invite.usedAt) return null;
  if (new Date(member.invite.expiresAt).getTime() < Date.now()) return null;

  const [user, org] = await Promise.all([
    User.findById(member.userId).select("email name").lean<{
      email: string;
      name: string;
    } | null>(),
    Organization.findById(member.orgId).select("name").lean<{
      name: string;
    } | null>(),
  ]);
  if (!user) return null;
  return {
    email: user.email,
    defaultName: user.name,
    orgName: org?.name ?? "the team",
  };
}

/**
 * Accept a team invitation: atomically claim the single-use token, then set
 * the pre-created User's real password + activate them, joining the OWNER's
 * existing org. Never creates a new workspace. The claim is flipped BEFORE
 * provisioning so two concurrent clicks can't both activate; on a
 * provisioning failure the claim is released so a legitimate retry works.
 * Email/identity are read from the pre-created User (via member.userId),
 * NEVER from the request — the token is email-bound.
 */
export async function activateTeamInvite(
  rawToken: string,
  input: { name?: string; password: string },
  ctx: RequestContext | null,
): Promise<{
  user: { id: string; email: string; name: string; role: UserRole };
  orgId: string;
}> {
  await connectMongo();
  const now = new Date();

  const member = await OrgMember.findOneAndUpdate(
    {
      "invite.tokenHash": hashInviteToken(rawToken),
      "invite.usedAt": null,
      "invite.expiresAt": { $gt: now },
      // Only an ACTIVE membership can be joined — if the owner archived the
      // membership, the token is dead (revocation).
      status: RecordState.ACTIVE,
    },
    { $set: { "invite.usedAt": now } },
    { new: true },
  );
  if (!member) {
    throw new ValidationError(
      "This invitation link is invalid, expired, or has already been used.",
    );
  }

  try {
    const user = await User.findById(member.userId).select("+passwordHash");
    if (!user) throw new NotFoundError("User not found");

    // Revocation guard: a pending invitee is DISABLED until they accept. If
    // the owner archived (or otherwise moved) the account, the still-live
    // token must NOT resurrect it — only a DISABLED (pending) user may
    // activate. The catch below releases the claim.
    if (user.status !== RecordState.DISABLED) {
      throw new ValidationError("This invitation is no longer valid.");
    }

    // Firebase first: /login signs in through it, so an invitee whose
    // password lands only in Mongo is told their correct password is
    // wrong. If this throws, the catch below releases the claim and the
    // invitation stays usable rather than being burned half-accepted.
    await syncFirebasePassword(user.email, input.password);
    user.passwordHash = await hashPassword(input.password);
    if (input.name?.trim()) user.name = input.name.trim().slice(0, 120);
    user.status = RecordState.ACTIVE;
    if (!user.primaryOrgId) user.primaryOrgId = member.orgId;
    await user.save();

    if (member.joinedAt == null) {
      member.joinedAt = now;
      await member.save();
    }

    await recordAudit({
      action: AuditAction.USER_INVITE_ACCEPTED,
      entityType: AuditEntity.USER,
      entityId: String(user._id),
      actor: { userId: String(user._id), name: user.name, role: member.role },
      request: ctx,
      metadata: { orgId: String(member.orgId) },
    });

    return {
      user: {
        id: String(user._id),
        email: user.email,
        name: user.name,
        role: member.role,
      },
      orgId: String(member.orgId),
    };
  } catch (err) {
    // Release the single-use claim so a legitimate retry is possible.
    await OrgMember.updateOne(
      { _id: member._id },
      { $set: { "invite.usedAt": null } },
    );
    throw err;
  }
}

/**
 * Owner-only: regenerate a pending member's invite token (rotating the
 * previously-emailed link dead), re-arm the expiry, and re-send the email.
 * Org-scoped — an owner of org A gets a NotFound for a member of org B.
 * Rejected once the invite has been accepted.
 */
export async function resendTeamInvite(
  userId: string,
  ctx: {
    actor: { id: string; name: string; role: UserRole };
    orgId: string;
    request?: RequestContext | null;
  },
): Promise<void> {
  await connectMongo();
  if (!Types.ObjectId.isValid(userId)) throw new NotFoundError("User not found");

  // Org-scope guard: a member of another org simply isn't found here.
  const member = await OrgMember.findOne({
    orgId: new Types.ObjectId(ctx.orgId),
    userId: new Types.ObjectId(userId),
    status: { $ne: RecordState.ARCHIVED },
  });
  if (!member || !member.invite) {
    throw new NotFoundError("No pending invitation for this member");
  }
  if (member.invite.usedAt) {
    throw new ValidationError("This member has already accepted their invitation");
  }

  const [user, org] = await Promise.all([
    User.findById(userId).select("email name role").lean<{
      email: string;
      name: string;
      role: UserRole;
    } | null>(),
    Organization.findById(member.orgId).select("name").lean<{
      name: string;
    } | null>(),
  ]);
  if (!user) throw new NotFoundError("User not found");

  const { rawToken, invite } = mintTeamInvite();

  // Send the new link FIRST. Only once it's actually out the door do we
  // rotate the stored token — so a delivery failure leaves the member's
  // existing (previously-emailed) invite link working rather than killing it
  // with nothing to replace it.
  await dispatchTeamInvite({
    to: user.email,
    inviteeName: user.name,
    role: member.role,
    orgName: org?.name ?? "the team",
    inviterName: ctx.actor.name,
    rawToken,
  });

  member.invite = { ...invite, sentAt: new Date() };
  await member.save();

  await recordAudit({
    action: AuditAction.USER_UPDATED,
    entityType: AuditEntity.USER,
    entityId: userId,
    actor: {
      userId: ctx.actor.id,
      name: ctx.actor.name,
      role: ctx.actor.role,
    },
    request: ctx.request ?? null,
    metadata: { action: "invite_resent" },
  });
}
