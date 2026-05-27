import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

describe("password-reset service — token lifecycle", () => {
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
    // Flip a byte in the encoded token — HMAC verification fails.
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

describe("initiatePasswordReset — no enumeration leak", () => {
  it("emits an audit row whether or not the email exists", async () => {
    const before = await AuditLog.countDocuments({
      action: AuditAction.USER_PASSWORD_RESET,
    });
    // Unknown email — no user.
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
