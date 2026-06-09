import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UserRole, RecordState } from "@/lib/constants/enums";
import { GET as listRoute, POST as createUserRoute } from "@/app/api/admin/users/route";
import { ForbiddenError } from "@/lib/errors";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { buildRequest, expectErr, expectOk, jsonBody } from "@/tests/utils/api";
import { mockNextHeaders } from "@/tests/utils/next-headers";
import { ensureMongo } from "@/tests/utils/db";
import { createUser } from "@/tests/factories/user.factory";

let headers: Awaited<ReturnType<typeof mockNextHeaders>>;
let session: Awaited<ReturnType<typeof mockSession>> | null = null;

beforeEach(async () => {
  await ensureMongo();
  headers = await mockNextHeaders();
});

afterEach(async () => {
  await headers.restore();
  if (session) {
    session.restore();
    session = null;
  }
});

describe("POST /api/admin/users (RBAC)", () => {
  it("ADMIN can create a STAFF user", async () => {
    session = await mockSession(actorFor(UserRole.ADMIN));
    const res = await createUserRoute(
      buildRequest("/api/admin/users", {
        method: "POST",
        body: {
          name: "New Staff",
          email: "staffer@tracetxn.test",
          role: UserRole.STAFF,
          password: "Hunter2Hunter2",
        },
      }),
    );
    const { status, body } = await jsonBody(res);
    expect(status).toBe(201);
    expectOk(body as never);
  });

  it("ADMIN cannot create a SUPER_ADMIN, returns 403", async () => {
    session = await mockSession(actorFor(UserRole.ADMIN));
    const res = await createUserRoute(
      buildRequest("/api/admin/users", {
        method: "POST",
        body: {
          name: "Sneak",
          email: "sneak@tracetxn.test",
          role: UserRole.SUPER_ADMIN,
          password: "Hunter2Hunter2",
        },
      }),
    );
    expect(res.status).toBe(403);
    const { body } = await jsonBody(res);
    expectErr(body as never);
  });

  it("SUPER_ADMIN can create a SUPER_ADMIN", async () => {
    session = await mockSession(actorFor(UserRole.SUPER_ADMIN));
    const res = await createUserRoute(
      buildRequest("/api/admin/users", {
        method: "POST",
        body: {
          name: "Super",
          email: "super2@tracetxn.test",
          role: UserRole.SUPER_ADMIN,
          password: "Hunter2Hunter2",
        },
      }),
    );
    expect(res.status).toBe(201);
  });

  it("STAFF role can't even reach this route, requirePermission throws", async () => {
    session = await mockSession(actorFor(UserRole.STAFF));
    // requirePermission throws ForbiddenError → withApi turns it into 403
    const res = await createUserRoute(
      buildRequest("/api/admin/users", {
        method: "POST",
        body: {
          name: "x",
          email: "x@tracetxn.test",
          role: UserRole.STAFF,
          password: "Hunter2Hunter2",
        },
      }),
    );
    expect(res.status).toBe(403);
    expect(ForbiddenError).toBeDefined();
  });
});

describe("GET /api/admin/users", () => {
  it("returns a list, no password fields exposed", async () => {
    await createUser({ email: "alice@tracetxn.test", role: UserRole.STAFF });
    await createUser({ email: "bob@tracetxn.test", role: UserRole.STAFF });

    session = await mockSession(actorFor(UserRole.ADMIN));
    const res = await listRoute(buildRequest("/api/admin/users"));
    const { status, body } = await jsonBody(res);
    expect(status).toBe(200);

    const items = (body as { data: { items: unknown[] } }).data.items as Array<
      Record<string, unknown>
    >;
    expect(items.length).toBeGreaterThanOrEqual(2);
    for (const item of items) {
      expect(item.passwordHash).toBeUndefined();
      expect(item.status).toBe(RecordState.ACTIVE);
    }
  });

  it("filters by role", async () => {
    await createUser({ email: "s1@tracetxn.test", role: UserRole.STAFF });
    await createUser({ email: "a1@tracetxn.test", role: UserRole.ADMIN });

    session = await mockSession(actorFor(UserRole.SUPER_ADMIN));
    const res = await listRoute(
      buildRequest("/api/admin/users", {
        searchParams: { role: UserRole.STAFF },
      }),
    );
    const { body } = await jsonBody(res);
    const items = (body as { data: { items: Array<{ role: string }> } }).data
      .items;
    expect(items.every((u) => u.role === UserRole.STAFF)).toBe(true);
  });
});
