import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST as loginRoute } from "@/app/api/auth/login/route";
import { buildRequest, expectErr, expectOk, jsonBody } from "@/tests/utils/api";
import { mockNextHeaders } from "@/tests/utils/next-headers";
import { ensureMongo } from "@/tests/utils/db";
import { createUser } from "@/tests/factories/user.factory";

/**
 * /api/auth/login route, drives the real handler with a constructed
 * NextRequest. We assert:
 *
 *   - happy-path returns the public user envelope + sets the session cookie
 *   - bad credentials return UNAUTHORIZED with the standard error shape
 *   - input validation kicks in before auth (422 from zod)
 *   - the cookie is HttpOnly with the configured name
 */

let headersMock: Awaited<ReturnType<typeof mockNextHeaders>>;

beforeEach(async () => {
  await ensureMongo();
  headersMock = await mockNextHeaders();
});

afterEach(async () => {
  await headersMock.restore();
});

describe("POST /api/auth/login", () => {
  it("returns 200 + sets the session cookie on valid credentials", async () => {
    await createUser({
      email: "ada@tracetxn.test",
      password: "Hunter2Hunter2",
    });

    const req = buildRequest("/api/auth/login", {
      method: "POST",
      body: { email: "ada@tracetxn.test", password: "Hunter2Hunter2" },
    });

    const res = await loginRoute(req);
    const { status, body } = await jsonBody(res);

    expect(status).toBe(200);
    expectOk(body as never);
    expect((body as { data: { email: string } }).data.email).toBe(
      "ada@tracetxn.test",
    );

    const cookieName = process.env.COOKIE_NAME ?? "tracetxn_session";
    expect(headersMock.cookieJar.get(cookieName)).toBeTruthy();
  });

  it("returns 422 with VALIDATION_ERROR when the body is malformed", async () => {
    const req = buildRequest("/api/auth/login", {
      method: "POST",
      body: { email: "not-an-email", password: "short" },
    });
    const res = await loginRoute(req);
    const { status, body } = await jsonBody(res);

    expect(status).toBe(422);
    expectErr(body as never);
    expect((body as { error: { code: string } }).error.code).toBe(
      "VALIDATION_ERROR",
    );
  });

  it("returns 401 UNAUTHORIZED on a wrong password", async () => {
    await createUser({
      email: "bad@tracetxn.test",
      password: "Hunter2Hunter2",
    });
    const req = buildRequest("/api/auth/login", {
      method: "POST",
      body: { email: "bad@tracetxn.test", password: "wrong-one" },
    });
    const res = await loginRoute(req);
    const { status, body } = await jsonBody(res);

    expect(status).toBe(401);
    expectErr(body as never);
    expect((body as { error: { code: string } }).error.code).toBe(
      "UNAUTHORIZED",
    );
  });

  it("returns 401 UNAUTHORIZED for an unknown email (no enumeration)", async () => {
    const req = buildRequest("/api/auth/login", {
      method: "POST",
      body: { email: "nobody@tracetxn.test", password: "Hunter2Hunter2" },
    });
    const res = await loginRoute(req);
    const { status, body } = await jsonBody(res);
    expect(status).toBe(401);
    expectErr(body as never);
  });
});
