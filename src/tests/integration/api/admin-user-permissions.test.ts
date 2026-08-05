import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UserRole } from "@/lib/constants/enums";
import { PATCH as permissionsRoute } from "@/app/api/admin/users/[id]/permissions/route";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { buildRequest, jsonBody } from "@/tests/utils/api";
import { mockNextHeaders } from "@/tests/utils/next-headers";
import { ensureMongo } from "@/tests/utils/db";
import { createOrgUser } from "@/tests/factories/user.factory";

/**
 * The permission-writer route is the single most sensitive RBAC operation —
 * it rewrites a member's effective grants. Its gate is `requireOwner()`
 * (workspaceRole === "OWNER"), deliberately NOT the mutable USER_UPDATE
 * permission. If that gate ever inverted, a non-owner MEMBER could escalate a
 * coworker's (or their own) permissions and every service-level test would
 * still pass. This test pins the authz boundary at the route.
 */

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

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const validBody = { permissionMode: "full" as const, permissions: [] as string[] };

describe("PATCH /api/admin/users/[id]/permissions (requireOwner)", () => {
  it("403s a non-OWNER actor — the privilege-escalation guard", async () => {
    // ADMIN role → workspaceRole MEMBER, so the OWNER-only gate must reject it
    // BEFORE any permission write happens.
    const actor = actorFor(UserRole.ADMIN);
    session = await mockSession(actor);
    const target = await createOrgUser(actor.orgId);

    const res = await permissionsRoute(
      buildRequest(
        `/api/admin/users/${String(target._id)}/permissions`,
        { method: "PATCH", body: validBody },
      ),
      params(String(target._id)),
    );
    const { status, body } = await jsonBody(res);
    expect(status).toBe(403);
    expect((body as { error: { code: string } }).error.code).toBe("FORBIDDEN");
  });

  it("lets an OWNER rewrite a member's permissions", async () => {
    const owner = actorFor(UserRole.SUPER_ADMIN); // → workspaceRole OWNER
    session = await mockSession(owner);
    const target = await createOrgUser(owner.orgId);

    const res = await permissionsRoute(
      buildRequest(
        `/api/admin/users/${String(target._id)}/permissions`,
        { method: "PATCH", body: validBody },
      ),
      params(String(target._id)),
    );
    const { status } = await jsonBody(res);
    expect(status).toBe(200);
  });
});
