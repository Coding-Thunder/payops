import "server-only";

import crypto from "node:crypto";

import mongoose from "mongoose";
import bcrypt from "bcryptjs";

import { connectMongo } from "@/server/db/mongoose";
import { Organization, OrgMember, Quotation, User, Types } from "@/server/db/models";
import { generateResetToken, buildSetPasswordUrl } from "@/server/auth/reset-token";
import { sendAccessLinkEmail } from "@/server/email/mailer";
import { recordAdminAction } from "@/server/audit";

export type GrantResult =
  | { status: "granted"; email: string; userId: string; orgId: string }
  | { status: "already_active"; email: string; userId: string }
  | { status: "error"; message: string };

function baseSlug(input: string): string {
  let s = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(s)) s = `org-${s}`;
  s = s.replace(/^-+|-+$/g, "");
  if (s.length < 2) s = `${s}org`.slice(0, 4);
  return s.slice(0, 32).replace(/-+$/, "") || "org";
}

// Mirror of the main app's signup guard (src/server/services/
// signup.service.ts RESERVED_SLUGS + ORG_SLUG_REGEX). Keep in sync: a slug
// this console mints must be one the main app's signup would also allow.
const ORG_SLUG_REGEX = /^[a-z][a-z0-9-]{1,31}$/;
const RESERVED_SLUGS = new Set<string>([
  "admin", "api", "app", "auth", "billing", "console", "dashboard", "docs",
  "help", "login", "logout", "marketing", "payments", "pay", "platform",
  "settings", "signup", "static", "status", "support", "system", "www",
  "tracetxn", "payops", "legacy", "amazon", "apple", "facebook", "google",
  "meta", "microsoft", "netflix", "openai", "stripe", "twitter", "x",
]);

async function uniqueOrgSlug(
  input: string,
  session: mongoose.ClientSession,
): Promise<string> {
  const base = baseSlug(input);
  let candidate = base;
  let n = 1;
  // Reject reserved words + regex-invalid + already-taken. The unique
  // index remains the backstop against races.
  while (
    RESERVED_SLUGS.has(candidate) ||
    !ORG_SLUG_REGEX.test(candidate) ||
    (await Organization.findOne({ slug: candidate })
      .session(session)
      .select({ _id: 1 })
      .lean())
  ) {
    n += 1;
    const suffix = `-${n}`;
    candidate = `${base.slice(0, 32 - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (n > 10_000) {
      candidate = `org-${String(n).slice(-6)}`;
      break;
    }
  }
  return candidate;
}

/**
 * Grant a waitlist entry access: provision an Org + owner User (mirroring
 * the main app's `signupFounder`) and email a set-password link that works
 * on the main app. Idempotent — an email that already has a user is not
 * re-provisioned.
 */
export async function grantAccessToWaitlist(
  quotationId: string,
  actorEmail: string,
  ip: string | null,
): Promise<GrantResult> {
  if (!Types.ObjectId.isValid(quotationId)) {
    return { status: "error", message: "Invalid waitlist id" };
  }
  await connectMongo();

  const q = await Quotation.findOne({
    _id: new Types.ObjectId(quotationId),
    source: "waitlist",
  });
  if (!q) return { status: "error", message: "Waitlist entry not found" };

  const email = (q.workEmail ?? "").trim().toLowerCase();
  if (!email) {
    return { status: "error", message: "Waitlist entry has no email" };
  }
  const name = (q.fullName ?? "").trim() || email.split("@")[0];
  const orgName = (q.companyName ?? "").trim() || name;

  // Idempotency: never double-provision an email that already has a user.
  const existing = await User.findOne({ email }).select({ _id: 1 }).lean<{
    _id: Types.ObjectId;
  } | null>();
  if (existing) {
    await Quotation.updateOne(
      { _id: q._id },
      {
        $set: {
          status: "QUALIFIED",
          grantedUserId: existing._id,
          grantedAt: q.grantedAt ?? new Date(),
          grantedBy: actorEmail,
        },
      },
    );
    await recordAdminAction({
      action: "waitlist.grant.already_active",
      actorEmail,
      targetType: "quotation",
      targetId: String(q._id),
      metadata: { email },
      ip,
    });
    return { status: "already_active", email, userId: String(existing._id) };
  }

  // Random password — the operator never sees it; the emailed reset link
  // is how the new user sets a real one.
  //
  // The set-password token embeds the first 8 chars of this hash, and the
  // main app's parseResetToken splits the payload on "." into exactly 4
  // parts. bcrypt's salt[0] can be "." (~1/64), which would add a 5th part
  // and permanently break the emailed link. Re-hash until the head is
  // dot-free so every provisioned link is redeemable.
  let passwordHash = await bcrypt.hash(crypto.randomBytes(24).toString("hex"), 10);
  while (passwordHash.slice(0, 8).includes(".")) {
    passwordHash = await bcrypt.hash(crypto.randomBytes(24).toString("hex"), 10);
  }

  const session = await mongoose.startSession();
  let userId: Types.ObjectId;
  let orgId: Types.ObjectId;
  try {
    await session.withTransaction(async () => {
      const [userDoc] = await User.create(
        [
          {
            name,
            email,
            passwordHash,
            role: "SUPER_ADMIN",
            status: "ACTIVE",
          },
        ],
        { session },
      );
      userId = userDoc._id;

      const slug = await uniqueOrgSlug(orgName, session);
      const [orgDoc] = await Organization.create(
        [
          {
            slug,
            name: orgName,
            ownerUserId: userId,
            status: "ACTIVE",
            verifiedAt: null,
            trialStartsAt: new Date(),
          },
        ],
        { session },
      );
      orgId = orgDoc._id;

      await OrgMember.create(
        [
          {
            orgId,
            userId,
            role: "SUPER_ADMIN",
            status: "ACTIVE",
            joinedAt: new Date(),
          },
        ],
        { session },
      );

      await User.updateOne(
        { _id: userId },
        { $set: { primaryOrgId: orgId } },
        { session },
      );

      await Quotation.updateOne(
        { _id: q._id },
        {
          $set: {
            status: "QUALIFIED",
            grantedUserId: userId,
            grantedAt: new Date(),
            grantedBy: actorEmail,
          },
        },
        { session },
      );
    });
  } finally {
    await session.endSession();
  }

  // Post-commit side effects: mint a main-app-compatible set-password
  // link and email it. A mail failure must not undo the provisioning.
  const token = generateResetToken(String(userId!), passwordHash);
  const url = buildSetPasswordUrl(token);
  try {
    await sendAccessLinkEmail({ to: email, name, url });
  } catch (err) {
    console.error("[admin] access-link email failed", err);
  }

  await recordAdminAction({
    action: "waitlist.grant",
    actorEmail,
    targetType: "quotation",
    targetId: String(q._id),
    metadata: { email, userId: String(userId!), orgId: String(orgId!) },
    ip,
  });

  return {
    status: "granted",
    email,
    userId: String(userId!),
    orgId: String(orgId!),
  };
}
