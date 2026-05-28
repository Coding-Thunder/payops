import { beforeEach, describe, expect, it } from "vitest";

import { AuditAction, RecordState } from "@/lib/constants/enums";
import { UnauthorizedError } from "@/lib/errors";
import { AuditLog, User } from "@/server/db/models";
import { verifySession } from "@/server/auth/jwt";
import { authenticate } from "@/server/services/auth.service";
import { createUser } from "@/tests/factories/user.factory";
import { ensureMongo } from "@/tests/utils/db";

/**
 * Authentication service — direct integration against the in-memory
 * Mongo. We assert:
 *
 *   - successful logins return a verifiable session JWT
 *   - bcrypt password verification gates the issued token
 *   - failure modes (wrong password, missing user, disabled account) all
 *     throw `UnauthorizedError` and emit USER_LOGIN_FAILED audit rows
 *   - the user's `lastLoginAt` is touched on a successful login
 *
 * No HTTP layer here — the route handler test exercises that surface
 * separately so we can keep this focused on the service behaviour.
 */

beforeEach(async () => {
  await ensureMongo();
});

describe("authenticate", () => {
  it("signs a verifiable session on a correct password", async () => {
    const user = await createUser({
      email: "ada@tracetxn.test",
      password: "Hunter2Hunter2",
    });

    const result = await authenticate(
      { email: "ada@tracetxn.test", password: "Hunter2Hunter2" },
      { ip: "1.2.3.4", userAgent: "vitest", requestId: "req-1" },
    );

    expect(result.user).toEqual({
      id: String(user._id),
      name: user.name,
      email: user.email,
      role: user.role,
    });
    const payload = await verifySession(result.token);
    expect(payload?.sub).toBe(String(user._id));
    expect(payload?.role).toBe(user.role);

    const refreshed = await User.findById(user._id);
    expect(refreshed?.lastLoginAt).toBeInstanceOf(Date);

    const audit = await AuditLog.findOne({
      action: AuditAction.USER_LOGIN,
      entityId: String(user._id),
    });
    expect(audit).not.toBeNull();
    expect(audit?.actor.userId?.toString()).toBe(String(user._id));
  });

  it("normalises the supplied email (case + whitespace)", async () => {
    await createUser({ email: "case@tracetxn.test", password: "Hunter2Hunter2" });

    const r = await authenticate(
      { email: "  CASE@TraceTxn.TEST  ", password: "Hunter2Hunter2" },
      null,
    );
    expect(r.user.email).toBe("case@tracetxn.test");
  });

  it("throws UnauthorizedError on an unknown email", async () => {
    await expect(
      authenticate(
        { email: "noone@tracetxn.test", password: "Hunter2Hunter2" },
        null,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedError);

    const audit = await AuditLog.findOne({
      action: AuditAction.USER_LOGIN_FAILED,
    });
    expect(audit).not.toBeNull();
    expect(audit?.metadata).toMatchObject({ reason: "user_not_found" });
  });

  it("throws UnauthorizedError on a bad password", async () => {
    await createUser({ email: "bad@tracetxn.test", password: "Hunter2Hunter2" });

    await expect(
      authenticate({ email: "bad@tracetxn.test", password: "wrong-one" }, null),
    ).rejects.toBeInstanceOf(UnauthorizedError);

    const audit = await AuditLog.findOne({
      action: AuditAction.USER_LOGIN_FAILED,
    });
    expect(audit?.metadata).toMatchObject({ reason: "bad_password" });
  });

  it("rejects DISABLED users even with the correct password", async () => {
    await createUser({
      email: "off@tracetxn.test",
      password: "Hunter2Hunter2",
      status: RecordState.DISABLED,
    });

    await expect(
      authenticate(
        { email: "off@tracetxn.test", password: "Hunter2Hunter2" },
        null,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedError);

    const audit = await AuditLog.findOne({
      action: AuditAction.USER_LOGIN_FAILED,
    });
    expect(audit?.metadata).toMatchObject({ reason: "status_DISABLED" });
  });

  it("uses the same error message for every failure mode (no enumeration leak)", async () => {
    const e1 = (await authenticate(
      { email: "nope@tracetxn.test", password: "Hunter2Hunter2" },
      null,
    ).catch((e: unknown) => e)) as Error;

    await createUser({
      email: "exists@tracetxn.test",
      password: "Hunter2Hunter2",
    });
    const e2 = (await authenticate(
      { email: "exists@tracetxn.test", password: "wrong-one" },
      null,
    ).catch((e: unknown) => e)) as Error;

    expect(e1).toBeInstanceOf(UnauthorizedError);
    expect(e2).toBeInstanceOf(UnauthorizedError);
    expect(e1.message).toBe(e2.message);
  });
});
