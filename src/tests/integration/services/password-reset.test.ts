import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Firebase Admin is stubbed for the whole file. `firebaseConfigured` defaults
 * to false, which reproduces the service-account-less environment the existing
 * tests already ran in, so their behaviour is unchanged.
 */
const firebaseAuth = {
  getUserByEmail: vi.fn(),
  updateUser: vi.fn(),
  createUser: vi.fn(),
  revokeRefreshTokens: vi.fn(),
};
let firebaseConfigured = false;
vi.mock("@/lib/firebase/admin", () => ({
  getFirebaseAdminAuth: () => (firebaseConfigured ? firebaseAuth : null),
  isFirebaseAdminConfigured: () => firebaseConfigured,
}));

import { AuditAction, RecordState, UserRole } from "@/lib/constants/enums";
import { AuditLog, User } from "@/server/db/models";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import {
  _generateResetTokenForTesting,
  completePasswordReset,
  initiatePasswordReset,
  parseResetToken,
} from "@/server/services/password-reset.service";
import { POST as forgotRoute } from "@/app/api/auth/forgot-password/route";
import { POST as resetRoute } from "@/app/api/auth/reset-password/route";
import { buildRequest, jsonBody } from "@/tests/utils/api";
import { mockNextHeaders } from "@/tests/utils/next-headers";
import { ensureMongo, resetDatabase } from "@/tests/utils/db";

/**
 * Phase 4b: forgot-password + reset-password flow.
 *
 * Invariants under test:
 *   - happy path: token → new password works; old password rejected
 *   - token auto-invalidates after a successful reset (passwordHashHead
 *     check prevents replay)
 *   - expired token rejected
 *   - tampered token rejected
 *   - disabled / missing user: same response shape as success (no
 *     account-enumeration)
 */

let headers: Awaited<ReturnType<typeof mockNextHeaders>>;

beforeEach(async () => {
  await ensureMongo();
  await resetDatabase();
  headers = await mockNextHeaders();
});

afterEach(async () => {
  await headers.restore();
});

async function makeUser(opts: { email?: string; status?: RecordState } = {}) {
  const passwordHash = await hashPassword("OldPass123ABC");
  const user = await User.create({
    name: "Ada",
    email: opts.email ?? "ada@x.test",
    passwordHash,
    role: UserRole.SUPER_ADMIN,
    status: opts.status ?? RecordState.ACTIVE,
  });
  return user;
}

describe("password-reset service, token lifecycle", () => {
  it("happy path: token + new password works; old password rejected", async () => {
    const user = await makeUser();
    const token = _generateResetTokenForTesting(
      user.toObject() as never,
    );

    await completePasswordReset(token, "NewPass456XYZ", { request: null });

    const reloaded = await User.findById(user._id).select(
      "+passwordHash",
    );
    expect(
      await verifyPassword("NewPass456XYZ", reloaded!.passwordHash),
    ).toBe(true);
    expect(await verifyPassword("OldPass123ABC", reloaded!.passwordHash)).toBe(
      false,
    );
  });

  it("token auto-invalidates after a successful reset (no replay)", async () => {
    const user = await makeUser();
    const token = _generateResetTokenForTesting(user.toObject() as never);

    await completePasswordReset(token, "NewPass456XYZ", { request: null });

    // Same token replayed → rejected because passwordHashHead changed.
    await expect(
      completePasswordReset(token, "AnotherPass789Q", { request: null }),
    ).rejects.toThrow(/already been changed|invalid or expired/i);
  });

  it("tampered token rejected", async () => {
    const user = await makeUser();
    const token = _generateResetTokenForTesting(user.toObject() as never);
    // Flip a byte in the encoded token, HMAC verification fails.
    const tampered = token.slice(0, -2) + (token.endsWith("A") ? "B" : "A");
    await expect(
      completePasswordReset(tampered, "NewPass456XYZ", { request: null }),
    ).rejects.toThrow(/invalid or expired/i);
  });

  it("garbage token rejected", async () => {
    await expect(
      completePasswordReset("not-a-real-token", "NewPass456XYZ", {
        request: null,
      }),
    ).rejects.toThrow(/invalid or expired/i);
  });

  it("parseResetToken returns the userId on a fresh token", async () => {
    const user = await makeUser();
    const token = _generateResetTokenForTesting(user.toObject() as never);
    const parsed = parseResetToken(token);
    expect(parsed.userId).toBe(String(user._id));
  });

  it("disabled user can't complete reset", async () => {
    const user = await makeUser({ status: RecordState.DISABLED });
    const token = _generateResetTokenForTesting(user.toObject() as never);
    await expect(
      completePasswordReset(token, "NewPass456XYZ", { request: null }),
    ).rejects.toThrow(/active/i);
  });
});

describe("initiatePasswordReset, no enumeration leak", () => {
  it("emits an audit row whether or not the email exists", async () => {
    const before = await AuditLog.countDocuments({
      action: AuditAction.USER_PASSWORD_RESET,
    });
    // Unknown email, no user.
    await initiatePasswordReset("nobody@x.test", { request: null });
    // Existing email.
    await makeUser({ email: "real@x.test" });
    await initiatePasswordReset("real@x.test", { request: null });
    const after = await AuditLog.countDocuments({
      action: AuditAction.USER_PASSWORD_RESET,
    });
    // Both calls leave a footprint (one "no_user", one "reset_email_sent").
    expect(after - before).toBe(2);
  });
});

describe("POST /api/auth/forgot-password", () => {
  it("returns 200 for unknown email (no enumeration)", async () => {
    const res = await forgotRoute(
      buildRequest("/api/auth/forgot-password", {
        method: "POST",
        body: { email: "ghost@x.test" },
      }),
    );
    const { status } = await jsonBody(res);
    expect(status).toBe(200);
  });

  it("returns 200 for an existing email", async () => {
    await makeUser({ email: "real@x.test" });
    const res = await forgotRoute(
      buildRequest("/api/auth/forgot-password", {
        method: "POST",
        body: { email: "real@x.test" },
      }),
    );
    const { status } = await jsonBody(res);
    expect(status).toBe(200);
  });

  it("422 on malformed email", async () => {
    const res = await forgotRoute(
      buildRequest("/api/auth/forgot-password", {
        method: "POST",
        body: { email: "not-an-email" },
      }),
    );
    const { status } = await jsonBody(res);
    expect(status).toBe(422);
  });
});

describe("POST /api/auth/reset-password", () => {
  it("rejects with 400 when the token is malformed", async () => {
    const res = await resetRoute(
      buildRequest("/api/auth/reset-password", {
        method: "POST",
        body: { token: "garbage-token-here", newPassword: "NewPass456XYZ" },
      }),
    );
    const { status } = await jsonBody(res);
    expect(status).toBe(400);
  });

  it("422 on weak new password", async () => {
    const user = await makeUser();
    const token = _generateResetTokenForTesting(user.toObject() as never);
    const res = await resetRoute(
      buildRequest("/api/auth/reset-password", {
        method: "POST",
        body: { token, newPassword: "weak" },
      }),
    );
    const { status } = await jsonBody(res);
    expect(status).toBe(422);
  });

  it("happy path returns 200 + persists the new hash", async () => {
    const user = await makeUser();
    const token = _generateResetTokenForTesting(user.toObject() as never);
    const res = await resetRoute(
      buildRequest("/api/auth/reset-password", {
        method: "POST",
        body: { token, newPassword: "FreshPass456!" },
      }),
    );
    const { status } = await jsonBody(res);
    expect(status).toBe(200);
    const reloaded = await User.findById(user._id).select("+passwordHash");
    expect(await verifyPassword("FreshPass456!", reloaded!.passwordHash)).toBe(
      true,
    );
  });
});

/**
 * Regression guard for the reported sign-in bug: "correct email and password
 * rejected".
 *
 * /login renders FirebaseAuthForm and calls signInWithEmailAndPassword, so
 * Firebase Auth is the store sign-in reads. This service only ever wrote a
 * bcrypt hash to Mongo. Completing a reset therefore set the password
 * somewhere sign-in never looks: the new password failed and the old Firebase
 * password kept working.
 */
describe("completePasswordReset keeps Firebase in step with Mongo", () => {
  beforeEach(() => {
    firebaseConfigured = true;
    firebaseAuth.getUserByEmail.mockReset();
    firebaseAuth.updateUser.mockReset();
    firebaseAuth.createUser.mockReset();
    firebaseAuth.revokeRefreshTokens.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => {
    firebaseConfigured = false;
  });

  it("updates the password on the existing Firebase identity", async () => {
    const user = await makeUser();
    const token = _generateResetTokenForTesting(user);
    firebaseAuth.getUserByEmail.mockResolvedValue({ uid: "fb-uid-1" });
    firebaseAuth.updateUser.mockResolvedValue({ uid: "fb-uid-1" });

    await completePasswordReset(token, "BrandNewPass456", { request: null });

    expect(firebaseAuth.getUserByEmail).toHaveBeenCalledWith(user.email);
    // Exact object match on purpose. `emailVerified` must be set on the
    // UPDATE branch too: /signup calls createUserWithEmailAndPassword before
    // the session exchange, so a failed exchange leaves an UNVERIFIED identity
    // behind. Updating only its password gives the user a Firebase login that
    // /api/auth/firebase-session then refuses (it requires a verified email),
    // and nothing in this codebase ever sends a verification mail — a lockout
    // with no way out.
    expect(firebaseAuth.updateUser).toHaveBeenCalledWith("fb-uid-1", {
      password: "BrandNewPass456",
      emailVerified: true,
    });
    expect(firebaseAuth.createUser).not.toHaveBeenCalled();
  });

  it("revokes Firebase refresh tokens, so a reset really does evict an attacker", async () => {
    // sessionsInvalidBefore only kills the app cookie. A live Firebase refresh
    // token would otherwise mint a fresh ID token, and
    // /api/auth/firebase-session would hand back a new session -- defeating
    // the whole point of revoking on reset.
    const user = await makeUser();
    const token = _generateResetTokenForTesting(user);
    firebaseAuth.getUserByEmail.mockResolvedValue({ uid: "fb-uid-1" });
    firebaseAuth.updateUser.mockResolvedValue({ uid: "fb-uid-1" });

    await completePasswordReset(token, "BrandNewPass456", { request: null });

    expect(firebaseAuth.revokeRefreshTokens).toHaveBeenCalledWith("fb-uid-1");
  });

  it("provisions a Firebase identity for a pre-Firebase account", async () => {
    const user = await makeUser();
    const token = _generateResetTokenForTesting(user);
    firebaseAuth.getUserByEmail.mockRejectedValue(
      Object.assign(new Error("no user"), { code: "auth/user-not-found" }),
    );
    firebaseAuth.createUser.mockResolvedValue({ uid: "fb-uid-new" });

    await completePasswordReset(token, "BrandNewPass456", { request: null });

    expect(firebaseAuth.createUser).toHaveBeenCalledWith({
      email: user.email,
      password: "BrandNewPass456",
      // Redeeming a single-use link sent to that mailbox is the proof of
      // control; /api/auth/firebase-session refuses to link an unverified one.
      emailVerified: true,
    });
  });

  it("aborts without touching Mongo when Firebase rejects, leaving the link usable", async () => {
    // The ordering guarantee. Writing Mongo first would burn the token AND
    // leave sign-in broken — the user would be locked out with no way back.
    const user = await makeUser();
    const token = _generateResetTokenForTesting(user);
    firebaseAuth.getUserByEmail.mockRejectedValue(
      Object.assign(new Error("backend unavailable"), {
        code: "auth/internal-error",
      }),
    );

    await expect(
      completePasswordReset(token, "BrandNewPass456", { request: null }),
    ).rejects.toThrow();

    const after = await User.findById(user._id).select("+passwordHash");
    // Old password still valid, new one never took.
    expect(await verifyPassword("OldPass123ABC", after!.passwordHash)).toBe(true);
    expect(await verifyPassword("BrandNewPass456", after!.passwordHash)).toBe(
      false,
    );

    // ...and the same token still works once Firebase recovers.
    firebaseAuth.getUserByEmail.mockResolvedValue({ uid: "fb-uid-1" });
    firebaseAuth.updateUser.mockResolvedValue({ uid: "fb-uid-1" });
    await completePasswordReset(token, "BrandNewPass456", { request: null });

    const healed = await User.findById(user._id).select("+passwordHash");
    expect(await verifyPassword("BrandNewPass456", healed!.passwordHash)).toBe(
      true,
    );
  });

  it("still completes the Mongo write when Firebase is not configured", async () => {
    // Local dev and any deployment still on the legacy bcrypt path.
    firebaseConfigured = false;
    const user = await makeUser();
    const token = _generateResetTokenForTesting(user);

    await completePasswordReset(token, "BrandNewPass456", { request: null });

    const after = await User.findById(user._id).select("+passwordHash");
    expect(await verifyPassword("BrandNewPass456", after!.passwordHash)).toBe(
      true,
    );
    expect(firebaseAuth.updateUser).not.toHaveBeenCalled();
  });
});
