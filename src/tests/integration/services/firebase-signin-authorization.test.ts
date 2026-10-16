import { Types } from "mongoose";
import { beforeEach, describe, expect, it } from "vitest";

import { AuditAction, RecordState, UserRole } from "@/lib/constants/enums";
import { ForbiddenError, UnauthorizedError } from "@/lib/errors";
import { AuditLog, OrgMember, User } from "@/server/db/models";
import { firebaseExchange } from "@/server/services/auth.service";
import { ensureMongo, resetDatabase } from "@/tests/utils/db";

/**
 * Who gets a session out of `firebaseExchange`, and what a refusal says.
 *
 * ── The reported failure ─────────────────────────────────────────────────
 *
 * A user with an existing account signed in on production /login and was told
 * "TraceTxn is in private beta — signups are invite-only. Please use an
 * invitation to create an account." They were signing IN, not signing up.
 *
 * The private-beta gate was NOT misfiring on accounts that exist: an existing
 * row is found by uid or by email and never reaches that branch. The branch
 * fires only when a VERIFIED Firebase identity has no User row at all — and it
 * answered every one of those states with signup guidance. The most likely
 * production path needs no fault at all: the Google chooser offers every
 * account in the browser and nothing scopes it to a work domain, so a visitor
 * can authenticate perfectly as the wrong identity. "Go and get an invitation"
 * is the one piece of advice that cannot help them.
 *
 * These tests pin both halves: an authorized user still gets in, and every
 * refusal is accurate, attributable in the audit log, and silent about whether
 * anyone else's account exists.
 */

beforeEach(async () => {
  await ensureMongo();
  await resetDatabase();
});

const BCRYPT_PLACEHOLDER = "$2b$12$" + "x".repeat(53);

async function seedAuthorizedUser(email: string, uid?: string) {
  const orgId = new Types.ObjectId();
  const user = await User.create({
    name: "Dana Owner",
    email,
    passwordHash: BCRYPT_PLACEHOLDER,
    role: UserRole.SUPER_ADMIN,
    status: RecordState.ACTIVE,
    primaryOrgId: orgId,
    ...(uid ? { externalAuth: { firebaseUid: uid } } : {}),
  });
  await OrgMember.create({
    orgId,
    userId: user._id,
    role: UserRole.SUPER_ADMIN,
    status: RecordState.ACTIVE,
    permissionMode: "full",
  });
  return { user, orgId };
}

describe("existing authorized user signs in", () => {
  it("lets a returning, uid-linked user straight through", async () => {
    const { user, orgId } = await seedAuthorizedUser(
      "dana@acme.test",
      "uid-dana",
    );

    const result = await firebaseExchange(
      {
        email: "dana@acme.test",
        emailVerified: true,
        firebaseUid: "uid-dana",
        displayName: null,
      },
      null,
      { allowSignup: false, intent: "signin" },
    );

    expect(result.user.id).toBe(String(user._id));
    expect(result.isNewUser).toBe(false);
    expect(result.orgId).toBe(String(orgId));
    expect(result.token).toBeTruthy();
    // No new tenant was created on a sign-in.
    expect(await User.countDocuments({})).toBe(1);
  });

  it("links a pre-Firebase account by verified email and signs it in", async () => {
    const { user } = await seedAuthorizedUser("legacy@acme.test");

    const result = await firebaseExchange(
      {
        email: "legacy@acme.test",
        emailVerified: true,
        firebaseUid: "uid-legacy-first-login",
        displayName: null,
      },
      null,
      { allowSignup: false, intent: "signin" },
    );

    expect(result.user.id).toBe(String(user._id));
    expect(result.isNewUser).toBe(false);

    // The uid is now bound, so the next sign-in takes the fast path.
    const after = await User.findById(user._id).lean<{
      externalAuth?: { firebaseUid?: string | null } | null;
    }>();
    expect(after?.externalAuth?.firebaseUid).toBe("uid-legacy-first-login");
  });

  it("is not forced through any invite check — allowSignup is irrelevant to it", async () => {
    await seedAuthorizedUser("dana@acme.test", "uid-dana");

    // Identical outcome whether or not an invite was presented: an existing
    // user must never depend on the signup gate.
    for (const opts of [
      { allowSignup: false as const, intent: "signin" as const },
      { allowSignup: true as const, intent: "signup" as const },
    ]) {
      const result = await firebaseExchange(
        {
          email: "dana@acme.test",
          emailVerified: true,
          firebaseUid: "uid-dana",
          displayName: null,
        },
        null,
        opts,
      );
      expect(result.isNewUser).toBe(false);
    }
  });
});

describe("existing Firebase identity WITHOUT an app account is denied", () => {
  it("refuses, and says which identity it refused — not 'get an invitation'", async () => {
    // The reported scenario: the account is dana@acme.test, but the visitor
    // authenticated as a different Google identity.
    await seedAuthorizedUser("dana@acme.test", "uid-dana");

    const attempt = firebaseExchange(
      {
        email: "dana.personal@gmail.test",
        emailVerified: true,
        firebaseUid: "uid-personal",
        displayName: "Dana",
      },
      null,
      { allowSignup: false, intent: "signin" },
    );

    await expect(attempt).rejects.toBeInstanceOf(ForbiddenError);
    // Names the identity the TOKEN carried, which is the visitor's own.
    await expect(attempt).rejects.toThrow(/dana\.personal@gmail\.test/);
    // Points at the real cause instead of a signup flow.
    await expect(attempt).rejects.toThrow(/more than one Google or email/i);
    // The old, misleading guidance is gone from the sign-in path.
    await expect(attempt).rejects.not.toThrow(/signups are invite-only/i);
    await expect(attempt).rejects.not.toThrow(/create an account/i);
  });

  it("does not disclose whether any OTHER address has an account", async () => {
    await seedAuthorizedUser("dana@acme.test", "uid-dana");

    const refusals: string[] = [];
    for (const email of ["dana.personal@gmail.test", "nobody@nowhere.test"]) {
      try {
        await firebaseExchange(
          {
            email,
            emailVerified: true,
            firebaseUid: "uid-" + email,
            displayName: null,
          },
          null,
          { allowSignup: false, intent: "signin" },
        );
      } catch (err) {
        refusals.push((err as Error).message);
      }
    }

    expect(refusals).toHaveLength(2);
    // An address that HAS an account and one that does not must produce the
    // same shape of answer, differing only in the visitor's own address.
    expect(refusals[0]!.replace("dana.personal@gmail.test", "X")).toBe(
      refusals[1]!.replace("nobody@nowhere.test", "X"),
    );
    // And neither mentions the address that does have an account.
    for (const m of refusals) expect(m).not.toContain("dana@acme.test");
  });

  it("records an audit row, so the next lockout is diagnosable", async () => {
    await expect(
      firebaseExchange(
        {
          email: "orphan@acme.test",
          emailVerified: true,
          firebaseUid: "uid-orphan",
          displayName: null,
        },
        null,
        { allowSignup: false, intent: "signin" },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const rows = await AuditLog.find({
      action: AuditAction.USER_LOGIN_FAILED,
    }).lean<{ metadata?: Record<string, unknown>; entityId?: string }[]>();

    expect(rows).toHaveLength(1);
    // Exact key set, not toMatchObject: that permits extra keys, so it would
    // prove the expected fields are present while saying nothing about what
    // else got written. For an audit row the second half is the point.
    expect(Object.keys(rows[0]!.metadata ?? {}).sort()).toEqual([
      "firebaseUid",
      "intent",
      "reason",
      "source",
    ]);
    expect(rows[0]!.metadata).toEqual({
      reason: "no_account_for_firebase_identity",
      source: "firebase",
      intent: "signin",
      firebaseUid: "uid-orphan",
    });
  });

  it("writes no credential of any kind into the audit row", async () => {
    // The exchange is handed values that look like the real request's
    // secrets. None of them may reach the audit collection — the row is read
    // by operators and exported, and `metadata` is Schema.Types.Mixed, so
    // nothing in the schema would stop a careless caller.
    const SECRETS = [
      "eyJhbGciOiJSUzI1NiIsImtpZCI6ImZhayJ9.fake-id-token.sig",
      "cf-turnstile-response-token-value",
      "s3cret-password-value",
    ];

    await expect(
      firebaseExchange(
        {
          email: "orphan@acme.test",
          emailVerified: true,
          firebaseUid: "uid-orphan",
          // The only free-text field the caller controls. If a future change
          // ever routed it into metadata, this catches it.
          displayName: SECRETS[2]!,
        },
        null,
        { allowSignup: false, intent: "signin" },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const rows = await AuditLog.find({}).lean();
    expect(rows).toHaveLength(1);
    const serialised = JSON.stringify(rows[0]);

    for (const secret of SECRETS) {
      expect(serialised).not.toContain(secret);
    }
    // And no field name that would imply one is being stored.
    for (const key of ["idToken", "cfToken", "password", "passwordHash", "token", "cookie"]) {
      expect(serialised.toLowerCase()).not.toContain(key.toLowerCase());
    }
  });

  it("creates nothing when it refuses", async () => {
    await expect(
      firebaseExchange(
        {
          email: "orphan@acme.test",
          emailVerified: true,
          firebaseUid: "uid-orphan",
          displayName: null,
        },
        null,
        { allowSignup: false, intent: "signin" },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);

    expect(await User.countDocuments({})).toBe(0);
    expect(await OrgMember.countDocuments({})).toBe(0);
  });
});

describe("private beta still closed to genuinely new accounts", () => {
  it("refuses a net-new signup when no invite was accepted", async () => {
    const attempt = firebaseExchange(
      {
        email: "stranger@example.test",
        emailVerified: true,
        firebaseUid: "uid-stranger",
        displayName: null,
      },
      null,
      { allowSignup: false, intent: "signup" },
    );

    await expect(attempt).rejects.toBeInstanceOf(ForbiddenError);
    await expect(attempt).rejects.toThrow(/invite-only/i);
    expect(await User.countDocuments({})).toBe(0);
  });

  it("FAILS CLOSED when the caller omits allowSignup entirely", async () => {
    // Was `opts?.allowSignup === false`, so an omitted option provisioned a
    // brand-new tenant — the inverse of the documented closed-by-default
    // contract. Only one route calls this today and it always passes the
    // flag; this pins the behaviour for the next caller.
    await expect(
      firebaseExchange(
        {
          email: "stranger@example.test",
          emailVerified: true,
          firebaseUid: "uid-stranger",
          displayName: null,
        },
        null,
        {},
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);

    await expect(
      firebaseExchange(
        {
          email: "stranger@example.test",
          emailVerified: true,
          firebaseUid: "uid-stranger",
          displayName: null,
        },
        null,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);

    expect(await User.countDocuments({})).toBe(0);
  });
});

describe("no session before every authorization check has passed", () => {
  it("refuses a non-ACTIVE account and issues no token", async () => {
    const orgId = new Types.ObjectId();
    const user = await User.create({
      name: "Disabled Dana",
      email: "disabled@acme.test",
      passwordHash: BCRYPT_PLACEHOLDER,
      role: UserRole.SUPER_ADMIN,
      status: RecordState.DISABLED,
      primaryOrgId: orgId,
    });

    const attempt = firebaseExchange(
      {
        email: "disabled@acme.test",
        emailVerified: true,
        firebaseUid: "uid-disabled",
        displayName: null,
      },
      null,
      { allowSignup: false, intent: "signin" },
    );

    await expect(attempt).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(attempt).rejects.toThrow(/not active/i);

    // AND the refusal must not have mutated the account it refused. The uid
    // link used to be written before this check, so a disabled user's row was
    // permanently bound to whatever identity attempted the sign-in.
    const after = await User.findById(user._id).lean<{
      externalAuth?: { firebaseUid?: string | null } | null;
    }>();
    expect(after?.externalAuth?.firebaseUid ?? null).toBeNull();
  });

  it("refuses an unverified email before any lookup by email", async () => {
    await seedAuthorizedUser("dana@acme.test");

    const attempt = firebaseExchange(
      {
        email: "dana@acme.test",
        emailVerified: false,
        firebaseUid: "uid-attacker",
        displayName: null,
      },
      null,
      { allowSignup: false, intent: "signin" },
    );

    await expect(attempt).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(attempt).rejects.toThrow(/verify your email/i);
    // The takeover guard: no uid may be stamped on the victim's row.
    const after = await User.findOne({ email: "dana@acme.test" }).lean<{
      externalAuth?: { firebaseUid?: string | null } | null;
    }>();
    expect(after?.externalAuth?.firebaseUid ?? null).toBeNull();
  });
});
