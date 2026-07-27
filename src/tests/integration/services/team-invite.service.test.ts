import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RecordState, UserRole } from "@/lib/constants/enums";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { OrgMember, Organization, User } from "@/server/db/models";
import { getMailer } from "@/server/email/smtp";
import {
  activateTeamInvite,
  getInviteForActivation,
  hashInviteToken,
  mintTeamInvite,
  resendTeamInvite,
} from "@/server/services/team-invite.service";
import { ensureMongo, resetDatabase } from "@/tests/utils/db";

// Stub only the transport so the required invite email "sends".
vi.mock("@/server/email/smtp", async (importActual) => {
  const actual = await importActual<typeof import("@/server/email/smtp")>();
  return { ...actual, getMailer: vi.fn(), verifyMailer: vi.fn() };
});
const mockGetMailer = vi.mocked(getMailer);

beforeEach(async () => {
  await ensureMongo();
  await resetDatabase();
  mockGetMailer.mockReturnValue({
    sendMail: vi.fn().mockResolvedValue({ messageId: "test" }),
  } as unknown as ReturnType<typeof getMailer>);
});

interface SeedOpts {
  orgId?: string;
  expiresAt?: Date;
  email?: string;
  orgName?: string;
}

/** Seed an invited (DISABLED) member + return the RAW token (never persisted
 *  in the app — only available here because the test minted it). */
async function seedInvitedMember(opts: SeedOpts = {}) {
  const orgId = new Types.ObjectId(opts.orgId ?? new Types.ObjectId().toString());
  await Organization.create({
    _id: orgId,
    slug: `test-${orgId.toString().slice(-8)}`,
    name: opts.orgName ?? "Acme Agency",
    ownerUserId: new Types.ObjectId(),
    status: "ACTIVE",
  });
  const { rawToken, invite } = mintTeamInvite();
  if (opts.expiresAt) invite.expiresAt = opts.expiresAt;
  const user = await User.create({
    name: "Pat Invitee",
    email: opts.email ?? `invitee-${orgId.toString()}@tracetxn.test`,
    passwordHash: "invite:pending:placeholder",
    role: UserRole.STAFF,
    status: RecordState.DISABLED,
    primaryOrgId: orgId,
  });
  const member = await OrgMember.create({
    orgId,
    userId: user._id,
    role: UserRole.STAFF,
    status: RecordState.ACTIVE,
    joinedAt: new Date(),
    invite: { ...invite, sentAt: new Date() },
  });
  return { rawToken, user, member, orgId: orgId.toString() };
}

const GOOD_PASSWORD = "Hunter2Hunter2";

describe("getInviteForActivation", () => {
  it("returns the bound identity for a valid token", async () => {
    const { rawToken, user } = await seedInvitedMember({ orgName: "Acme Agency" });
    const out = await getInviteForActivation(rawToken);
    expect(out).not.toBeNull();
    expect(out?.email).toBe(user.email);
    expect(out?.orgName).toBe("Acme Agency");
  });

  it("returns null for an expired token", async () => {
    const { rawToken } = await seedInvitedMember({
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(await getInviteForActivation(rawToken)).toBeNull();
  });

  it("returns null for an unknown / too-short token", async () => {
    expect(await getInviteForActivation("short")).toBeNull();
    expect(await getInviteForActivation("x".repeat(43))).toBeNull();
  });
});

describe("activateTeamInvite", () => {
  it("sets the password, activates the user, and joins the existing org", async () => {
    const { rawToken, user, orgId } = await seedInvitedMember();
    const before = await User.findById(user._id).select("+passwordHash");

    const result = await activateTeamInvite(
      rawToken,
      { name: "Pat Real", password: GOOD_PASSWORD },
      null,
    );

    expect(result.orgId).toBe(orgId);
    expect(result.user.role).toBe(UserRole.STAFF);

    const after = await User.findById(user._id).select("+passwordHash");
    expect(after?.status).toBe(RecordState.ACTIVE);
    expect(after?.name).toBe("Pat Real");
    expect(after?.passwordHash).not.toBe(before?.passwordHash);
    expect(after?.passwordHash).toMatch(/^\$2[aby]\$/);
  });

  it("is single-use — a second activation with the same token fails", async () => {
    const { rawToken } = await seedInvitedMember();
    await activateTeamInvite(rawToken, { password: GOOD_PASSWORD }, null);
    await expect(
      activateTeamInvite(rawToken, { password: GOOD_PASSWORD }, null),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects an expired token", async () => {
    const { rawToken } = await seedInvitedMember({
      expiresAt: new Date(Date.now() - 1000),
    });
    await expect(
      activateTeamInvite(rawToken, { password: GOOD_PASSWORD }, null),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("releases the single-use claim when provisioning fails (retryable)", async () => {
    const { rawToken, user, member } = await seedInvitedMember();
    // Simulate a provisioning failure: the target User vanishes after claim.
    await User.deleteOne({ _id: user._id });
    await expect(
      activateTeamInvite(rawToken, { password: GOOD_PASSWORD }, null),
    ).rejects.toBeInstanceOf(NotFoundError);
    const reread = await OrgMember.findById(member._id);
    expect(reread?.invite?.usedAt ?? null).toBeNull(); // claim rolled back
  });

  it("marks the invite used so its status derives to active", async () => {
    const { rawToken } = await seedInvitedMember();
    await activateTeamInvite(rawToken, { password: GOOD_PASSWORD }, null);
    // The now-used token no longer resolves for activation.
    expect(await getInviteForActivation(rawToken)).toBeNull();
  });

  it("refuses activation after the owner revoked (archived) the member", async () => {
    const { rawToken, user } = await seedInvitedMember();
    // Owner revokes the pending invite by archiving the account.
    await User.updateOne(
      { _id: user._id },
      { $set: { status: RecordState.ARCHIVED } },
    );
    await expect(
      activateTeamInvite(rawToken, { password: GOOD_PASSWORD }, null),
    ).rejects.toBeInstanceOf(ValidationError);
    // The still-live token did NOT resurrect the archived account.
    const after = await User.findById(user._id);
    expect(after?.status).toBe(RecordState.ARCHIVED);
  });

  it("refuses activation when the membership itself was archived", async () => {
    const { rawToken, member } = await seedInvitedMember();
    await OrgMember.updateOne(
      { _id: member._id },
      { $set: { status: RecordState.ARCHIVED } },
    );
    await expect(
      activateTeamInvite(rawToken, { password: GOOD_PASSWORD }, null),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("resendTeamInvite", () => {
  const actor = { id: new Types.ObjectId().toString(), name: "Owner", role: UserRole.SUPER_ADMIN };

  it("rotates the token so the previously-emailed link dies", async () => {
    const { rawToken, user, orgId } = await seedInvitedMember();
    await resendTeamInvite(String(user._id), { actor, orgId, request: null });
    // Old link no longer works (tokenHash rotated).
    expect(await getInviteForActivation(rawToken)).toBeNull();
    // A fresh email was dispatched.
    expect(mockGetMailer).toHaveBeenCalled();
  });

  it("rejects a member who has already accepted", async () => {
    const { rawToken, user, orgId } = await seedInvitedMember();
    await activateTeamInvite(rawToken, { password: GOOD_PASSWORD }, null);
    await expect(
      resendTeamInvite(String(user._id), { actor, orgId, request: null }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("is org-scoped — an owner of another org cannot resend (404)", async () => {
    const { user } = await seedInvitedMember();
    const otherOrg = new Types.ObjectId().toString();
    await expect(
      resendTeamInvite(String(user._id), {
        actor,
        orgId: otherOrg,
        request: null,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("hashInviteToken", () => {
  it("is deterministic and never returns the raw token", () => {
    const raw = "some-raw-token-value-1234567890";
    const hash = hashInviteToken(raw);
    expect(hash).toBe(hashInviteToken(raw));
    expect(hash).not.toContain(raw);
  });
});
