import { Types } from "mongoose";
import { beforeEach, describe, expect, it } from "vitest";

import { RecordState, UserRole } from "@/lib/constants/enums";
import { UnauthorizedError } from "@/lib/errors";
import { User } from "@/server/db/models";
import { firebaseExchange } from "@/server/services/auth.service";
import { ensureMongo, resetDatabase } from "@/tests/utils/db";

/**
 * Regression: Firebase email-linking account takeover (deep-audit C-1).
 * An unverified Firebase email must NEVER link to / sign in as an existing
 * account discovered by email, nor provision a new one. Only a returning
 * user matched by their already-linked UID may skip the check.
 */
beforeEach(async () => {
  await ensureMongo();
  await resetDatabase();
});

async function seedLegacyUser(email: string) {
  return User.create({
    name: "Victim Owner",
    email,
    passwordHash: "$2b$12$" + "x".repeat(53), // bcrypt-shaped placeholder
    role: UserRole.SUPER_ADMIN,
    status: RecordState.ACTIVE,
    primaryOrgId: new Types.ObjectId(),
  });
}

describe("firebaseExchange — email-verification gate (takeover prevention)", () => {
  it("REFUSES to link an UNVERIFIED Firebase email to an existing account", async () => {
    const victim = await seedLegacyUser("victim@example.com");

    await expect(
      firebaseExchange(
        {
          email: "victim@example.com",
          emailVerified: false, // attacker's freshly-registered Firebase email
          firebaseUid: "attacker-uid-123",
          displayName: null,
        },
        null,
        { allowSignup: true },
      ),
    ).rejects.toBeInstanceOf(UnauthorizedError);

    // The attacker's UID must NOT have been stamped onto the victim row.
    const after = await User.findById(victim._id).select("+externalAuth");
    expect(after?.externalAuth?.firebaseUid ?? null).toBeNull();
  });

  it("REFUSES to provision a new account from an UNVERIFIED email", async () => {
    await expect(
      firebaseExchange(
        {
          email: "brand-new@example.com",
          emailVerified: false,
          firebaseUid: "some-uid",
          displayName: "Squatter",
        },
        null,
        { allowSignup: true },
      ),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(await User.exists({ email: "brand-new@example.com" })).toBeNull();
  });

  it("LINKS an existing account when the email IS verified (legit Google sign-in)", async () => {
    const victim = await seedLegacyUser("owner@example.com");

    const result = await firebaseExchange(
      {
        email: "owner@example.com",
        emailVerified: true,
        firebaseUid: "google-uid-abc",
        displayName: null,
      },
      null,
      { allowSignup: false },
    );

    expect(result.user.id).toBe(String(victim._id));
    const after = await User.findById(victim._id).select("+externalAuth");
    expect(after?.externalAuth?.firebaseUid).toBe("google-uid-abc");
  });

  it("lets a RETURNING user in by matched UID even if email_verified is false", async () => {
    // Simulates an already-linked account (the UID binding is itself proof).
    const user = await User.create({
      name: "Returning",
      email: "returning@example.com",
      passwordHash: "invite:pending:placeholder",
      role: UserRole.SUPER_ADMIN,
      status: RecordState.ACTIVE,
      primaryOrgId: new Types.ObjectId(),
      externalAuth: { firebaseUid: "linked-uid-xyz" },
    });

    const result = await firebaseExchange(
      {
        email: "returning@example.com",
        emailVerified: false,
        firebaseUid: "linked-uid-xyz",
        displayName: null,
      },
      null,
      { allowSignup: false },
    );
    expect(result.user.id).toBe(String(user._id));
  });
});
